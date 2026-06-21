// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * `SolidUpdateStore` — the persistence layer for {@link ../provider.js | SolidPersistence}.
 *
 * It implements the **append-only binary update-LOG** model: each Yjs binary
 * update (`Uint8Array` from `Y.encodeStateAsUpdate` or a `doc.on("update")`
 * event) is written to its OWN `application/octet-stream` LDP resource under one
 * configured container; loading the doc lists the container and reads every
 * member back, so the caller can apply/merge them into a `Y.Doc`.
 *
 * **Why an append-only log, not a single snapshot resource** (the documented
 * design decision):
 *   - **No read-modify-write race.** A single snapshot resource needs
 *     read→merge→write, which races between clients/tabs and risks last-write-
 *     wins data loss. Appending a fresh resource is a pure create — concurrent
 *     writers never clobber each other.
 *   - **Offline-friendly + crash-safe.** A queued update is one independent PUT;
 *     a partial flush leaves a valid (smaller) log, never a corrupt snapshot.
 *   - **Yjs CRDT semantics make merge order-independent + idempotent.** Applying
 *     updates in any order, or twice, converges to the same state — so the log
 *     is robust to out-of-order / duplicate delivery. We still mint
 *     lexicographically-sortable IDs (timestamp prefix + random suffix) so the
 *     load order is DETERMINISTIC (easier to reason about + test) and so
 *     {@link compact} can fold deterministically; correctness does not depend on
 *     it.
 *   - **Compaction is the GC for the log.** {@link compact} merges the whole log
 *     into one update (`Y.mergeUpdates`, supplied by the provider) written as a
 *     single fresh resource, then deletes the folded members — bounding the log
 *     size without ever leaving the doc unrepresented.
 *
 * **Injectable authenticated fetch.** The store does NO crypto / DPoP itself —
 * the caller injects an already-authenticated `fetch` (e.g. from
 * `@solid/reactive-authentication` or a client-credentials DPoP fetch). This
 * keeps it a pure LDP client, like `@jeswr/solid-memory`.
 *
 * **Scope guard on every op.** Every target URL is asserted to lie under
 * `container` (see {@link ./scope.js}) before any request — defence in depth, so
 * a caller-supplied or server-listed URL can never make the store touch a
 * foreign origin or escape the container sub-tree.
 *
 * **RDF discipline (house rule).** The ONLY RDF the store touches is the
 * container LISTING, parsed (read-only) via `@jeswr/fetch-rdf` `parseRdf` +
 * `@solid/object` `ContainerDataset`. The CRDT payload itself is BINARY and is
 * stored as `application/octet-stream` — we do NOT invent an RDF encoding for it.
 * No triples are ever hand-built.
 */
import { parseRdf } from "@jeswr/fetch-rdf";
import { ContainerDataset } from "@solid/object";
import { DataFactory } from "n3";
import { assertWithinBase, isContainerUrl, normalizeContainer } from "./scope.js";
/** The media type every update resource is stored with. */
export const UPDATE_CONTENT_TYPE = "application/octet-stream";
/**
 * Mint a lexicographically-sortable update resource name: a zero-padded
 * millisecond timestamp (sorts chronologically as a string) + a random suffix
 * (so two updates minted in the same millisecond never collide). The suffix uses
 * the WHATWG Web Crypto global `crypto.randomUUID()` (Node >=20 + every browser),
 * keeping the store browser-usable.
 *
 * 15 digits zero-pads a millisecond timestamp out to year ~33658, so string sort
 * stays chronological for any realistic time.
 */
function mintUpdateName(now = Date.now()) {
    const ts = String(now).padStart(15, "0");
    return `${ts}-${crypto.randomUUID()}`;
}
/**
 * The persistence store for a single Yjs doc's update log under one container.
 *
 * Construct with an absolute container URL + an authenticated fetch. The
 * constructor rejects a non-http(s) container and normalises it to a single
 * trailing slash.
 */
export class SolidUpdateStore {
    /** The normalised container URL (one trailing slash). */
    container;
    fetch;
    constructor(options) {
        // normalizeContainer throws on a non-http(s) / non-absolute container.
        this.container = normalizeContainer(options.container);
        this.fetch = options.fetch;
    }
    /**
     * Append a binary update to the log: PUT it to a freshly-minted
     * `application/octet-stream` resource under the container with
     * `If-None-Match: *` (a CONDITIONAL create — a minted-name collision fails
     * fast rather than overwriting). Returns the minted URL.
     *
     * @throws if the write is rejected (incl. a 412 collision).
     */
    async appendUpdate(update) {
        const url = `${this.container}${mintUpdateName()}`;
        // Defence in depth: a minted URL is always under the container, but assert it.
        assertWithinBase(this.container, url);
        const res = await this.fetch(url, {
            method: "PUT",
            headers: {
                "content-type": UPDATE_CONTENT_TYPE,
                "if-none-match": "*",
            },
            // Copy into a fresh ArrayBuffer-backed view so the body is a standalone
            // BodyInit (never a SharedArrayBuffer-backed view), independent of any
            // buffer Yjs may reuse for the next event.
            body: toBody(update),
        });
        if (!res.ok) {
            throw new Error(`[y-solid] appendUpdate ${url} failed: ${res.status} ${res.statusText}`);
        }
        return { url };
    }
    /**
     * List the direct `ldp:contains` members of the container that are update
     * resources. Returns an empty array for a missing container (404/410). Each
     * member is scope-guarded against the container — a foreign-origin / escaping
     * member listed by a hostile or buggy server is skipped, never surfaced. Sub-
     * containers (trailing slash) are skipped (an update resource is never a
     * container). The result is sorted by URL (lexicographic) — deterministic load
     * order (see the class doc on why correctness does not depend on it).
     *
     * @throws on any non-ok, non-404/410 response.
     */
    async listUpdateUrls() {
        const res = await this.fetch(this.container, {
            method: "GET",
            headers: { accept: "text/turtle, application/ld+json;q=0.9" },
        });
        if (res.status === 404 || res.status === 410) {
            return [];
        }
        if (!res.ok) {
            throw new Error(`[y-solid] list ${this.container} failed: ${res.status} ${res.statusText}`);
        }
        const body = await res.text();
        // parseRdf resolves relative IRIs against the container URL (baseIRI), so
        // ldp:contains object IRIs come back absolute.
        const dataset = await parseRdf(body, res.headers.get("content-type"), {
            baseIRI: this.container,
        });
        const container = new ContainerDataset(dataset, DataFactory).container;
        if (!container) {
            // A valid but empty / non-container document — no members.
            return [];
        }
        const urls = [];
        // The container lists ITSELF as a member; skip it. Compare on the normalised
        // origin + pathname (ignoring any query/fragment) so a root ALIAS a hostile
        // or buggy server might list — `…/doc/?x=1`, `…/doc/#frag` — is skipped too.
        const base = new URL(this.container);
        for (const resource of container.contains) {
            // resource.id may be relative; resolve against the container URL to be safe.
            const absolute = new URL(resource.id, this.container).toString();
            const member = new URL(absolute);
            if (member.origin === base.origin && member.pathname === base.pathname) {
                continue;
            }
            // An update resource is never a (sub-)container.
            if (isContainerUrl(absolute)) {
                continue;
            }
            // Defence in depth: never surface a member that escapes the container.
            try {
                assertWithinBase(this.container, absolute, { allowRoot: true });
            }
            catch {
                continue;
            }
            urls.push(absolute);
        }
        urls.sort();
        return urls;
    }
    /**
     * Read a single binary update resource. Returns `null` for a missing resource
     * (404/410).
     *
     * @throws if the target is outside the container, or on any non-ok,
     *   non-404/410 response.
     */
    async readUpdate(url) {
        assertWithinBase(this.container, url);
        const res = await this.fetch(url, {
            method: "GET",
            headers: { accept: UPDATE_CONTENT_TYPE },
        });
        if (res.status === 404 || res.status === 410) {
            return null;
        }
        if (!res.ok) {
            throw new Error(`[y-solid] readUpdate ${url} failed: ${res.status} ${res.statusText}`);
        }
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf);
    }
    /**
     * Load the whole update log: list the container, read every member, and return
     * them in deterministic (URL-sorted) order. Members that 404/410 between the
     * listing and the read (e.g. a concurrent {@link compact}) are skipped, not
     * fatal.
     */
    async loadUpdates() {
        const urls = await this.listUpdateUrls();
        const out = [];
        for (const url of urls) {
            const update = await this.readUpdate(url);
            if (update)
                out.push({ url, update });
        }
        return out;
    }
    /**
     * Delete a single update resource (used by {@link compact}). A missing
     * resource (404/410) is treated as already-deleted (no throw).
     *
     * @throws if the target is outside the container, or on any other non-ok
     *   response.
     */
    async deleteUpdate(url) {
        assertWithinBase(this.container, url);
        const res = await this.fetch(url, { method: "DELETE" });
        if (res.status === 404 || res.status === 410) {
            return;
        }
        if (!res.ok) {
            throw new Error(`[y-solid] deleteUpdate ${url} failed: ${res.status} ${res.statusText}`);
        }
    }
    /**
     * **Compact** the log: write `merged` (the caller folds the current log via
     * `Y.mergeUpdates` — the store stays Yjs-free) as a single fresh update
     * resource, THEN delete the members named in `obsoleteUrls`.
     *
     * **Write-before-delete ordering is load-bearing for safety:** the merged
     * snapshot is created FIRST, so even if the process dies mid-compaction the
     * doc is never unrepresented — at worst the log temporarily holds both the
     * merged update and the (still-valid, idempotent) originals. We only delete
     * the originals AFTER the merged write has succeeded.
     *
     * `obsoleteUrls` is each scope-guarded; the new merged resource's URL is
     * returned. Pass exactly the URLs you merged (typically every URL from the
     * {@link loadUpdates} that produced `merged`); any URL appended AFTER that
     * snapshot must NOT be in `obsoleteUrls` or its update would be lost.
     *
     * @throws if the merged write fails (before any delete) or a delete fails.
     */
    async compact(merged, obsoleteUrls) {
        // Guard the to-be-deleted URLs up front (fail before writing anything if any
        // is out of scope).
        for (const url of obsoleteUrls) {
            assertWithinBase(this.container, url);
        }
        const created = await this.appendUpdate(merged);
        for (const url of obsoleteUrls) {
            // Never delete the resource we just wrote (a minted name cannot collide
            // with an existing one, but guard against a caller passing it back).
            if (url === created.url)
                continue;
            await this.deleteUpdate(url);
        }
        return created;
    }
}
/**
 * Copy `update` into a standalone `Uint8Array` over a fresh `ArrayBuffer`, so the
 * request body never aliases a buffer Yjs may mutate/reuse, and is never backed
 * by a `SharedArrayBuffer` (not a valid `BodyInit`). Returns a `BodyInit`.
 */
function toBody(update) {
    const copy = new Uint8Array(update.byteLength);
    copy.set(update);
    return copy;
}
//# sourceMappingURL=store.js.map