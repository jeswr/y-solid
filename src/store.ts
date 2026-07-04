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
 * `container` (via `@jeswr/guarded-fetch`'s `assertWithinPodScope`, the suite's
 * consolidated pod-scope guard) before any request — defence in depth, so a
 * caller-supplied or server-listed URL can never make the store touch a
 * foreign origin or escape the container sub-tree. Write-target ops pass
 * `{ allowRoot: false }`; the listing op passes `{ allowRoot: true }`.
 *
 * **RDF discipline (house rule).** The ONLY RDF the store touches is the
 * container LISTING, parsed (read-only) via `@jeswr/fetch-rdf` `parseRdf` +
 * `@solid/object` `ContainerDataset`. The CRDT payload itself is BINARY and is
 * stored as `application/octet-stream` — we do NOT invent an RDF encoding for it.
 * No triples are ever hand-built.
 */

import { parseRdf } from "@jeswr/fetch-rdf";
import { assertWithinPodScope, isContainerUrl, normalizePodBase } from "@jeswr/guarded-fetch";
import { ContainerDataset } from "@solid/object";
import { DataFactory } from "n3";

/** The media type every update resource is stored with. */
export const UPDATE_CONTENT_TYPE = "application/octet-stream";

/**
 * Default fail-closed cap on the bytes read for a SINGLE update resource. A
 * hostile or buggy server could serve an unbounded (or chunked, content-length-
 * less) body on a member URL; reading it into memory unbounded is a DoS. 64 MiB
 * comfortably exceeds any realistic single Yjs update while bounding the read.
 * Override per store via `maxUpdateBytes`.
 */
export const DEFAULT_MAX_UPDATE_BYTES = 64 * 1024 * 1024;

/**
 * Default fail-closed cap on the bytes read for the container LISTING. A hostile
 * server could return an enormous Turtle/JSON-LD listing (millions of
 * `ldp:contains` triples) to exhaust memory before we even iterate members;
 * capping the read bounds both the parse cost and the member count. 16 MiB.
 * Override per store via `maxListingBytes`.
 */
export const DEFAULT_MAX_LISTING_BYTES = 16 * 1024 * 1024;

/** A single binary update read from (or to be written to) the log. */
export interface StoredUpdate {
  /** Absolute URL of the update resource. */
  readonly url: string;
  /** The raw binary Yjs update bytes. */
  readonly update: Uint8Array;
}

/** Options for {@link SolidUpdateStore} construction. */
export interface SolidUpdateStoreOptions {
  /** Absolute container URL the store owns (normalised to one trailing slash). */
  container: string;
  /** The (authenticated) fetch the store issues every request with. */
  fetch: typeof globalThis.fetch;
  /**
   * Fail-closed cap (bytes) on a single update resource read. Defaults to
   * {@link DEFAULT_MAX_UPDATE_BYTES}. A resource whose body exceeds this is
   * refused rather than buffered unbounded.
   */
  maxUpdateBytes?: number;
  /**
   * Fail-closed cap (bytes) on the container listing read. Defaults to
   * {@link DEFAULT_MAX_LISTING_BYTES}.
   */
  maxListingBytes?: number;
}

/**
 * Fail-closed refusal to FOLLOW a redirect on a credentialed request. The store
 * issues every request with the caller's AUTHENTICATED fetch, so a 3xx to a
 * foreign origin would replay the caller's credentials (bearer / DPoP-bound
 * token) off-container. We set `redirect: "manual"` on every request and treat
 * ANY redirect as a hard error:
 *   - browsers surface a filtered `opaqueredirect` response (`type` set,
 *     `status === 0`);
 *   - Node/undici surfaces the raw 3xx response (unfollowed).
 * Either way we refuse. (Suite recurring finding class: redirect-refusal SSRF.)
 */
function assertNotRedirected(res: Response, url: string): void {
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new Error(
      `[y-solid] request to ${url} was redirected (status ${res.status}); refused for credential safety`,
    );
  }
}

/**
 * Read a response body into bytes with a fail-closed size cap, streaming so an
 * unbounded (content-length-less) body cannot be buffered whole before the cap
 * is hit. Honours a declared `content-length` for a fast-fail, then enforces the
 * cap on the actual bytes streamed (a lying/absent content-length can't bypass
 * it). Throws if the body exceeds `cap`.
 */
async function readBodyCapped(res: Response, cap: number, url: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(
      `[y-solid] resource ${url} exceeds max size (content-length ${declared} > ${cap} bytes); refused`,
    );
  }
  const body = res.body;
  if (!body) {
    // No stream available (e.g. an empty body): fall back to a buffered read,
    // then enforce the cap on the materialised bytes.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > cap) {
      throw new Error(
        `[y-solid] resource ${url} exceeds max size (${buf.byteLength} > ${cap} bytes); refused`,
      );
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      // Stop pulling and refuse — never accumulate past the cap.
      await reader.cancel().catch(() => {});
      throw new Error(`[y-solid] resource ${url} exceeds max size (> ${cap} bytes); refused`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

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
function mintUpdateName(now: number = Date.now()): string {
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
  readonly container: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly maxUpdateBytes: number;
  private readonly maxListingBytes: number;

  constructor(options: SolidUpdateStoreOptions) {
    // normalizePodBase throws on a non-http(s) / non-absolute container.
    this.container = normalizePodBase(options.container);
    this.fetch = options.fetch;
    this.maxUpdateBytes = clampPositive(options.maxUpdateBytes, DEFAULT_MAX_UPDATE_BYTES);
    this.maxListingBytes = clampPositive(options.maxListingBytes, DEFAULT_MAX_LISTING_BYTES);
  }

  /**
   * Append a binary update to the log: PUT it to a freshly-minted
   * `application/octet-stream` resource under the container with
   * `If-None-Match: *` (a CONDITIONAL create — a minted-name collision fails
   * fast rather than overwriting). Returns the minted URL.
   *
   * @throws if the write is rejected (incl. a 412 collision).
   */
  async appendUpdate(update: Uint8Array): Promise<{ url: string }> {
    const url = `${this.container}${mintUpdateName()}`;
    // Defence in depth: a minted URL is always under the container, but assert
    // it. Write-target semantics: the container root is never a managed
    // resource (allowRoot: false).
    assertWithinPodScope(this.container, url, { allowRoot: false });
    const res = await this.fetch(url, {
      method: "PUT",
      redirect: "manual",
      headers: {
        "content-type": UPDATE_CONTENT_TYPE,
        "if-none-match": "*",
      },
      // Copy into a fresh ArrayBuffer-backed view so the body is a standalone
      // BodyInit (never a SharedArrayBuffer-backed view), independent of any
      // buffer Yjs may reuse for the next event.
      body: toBody(update),
    });
    assertNotRedirected(res, url);
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
  async listUpdateUrls(): Promise<string[]> {
    const res = await this.fetch(this.container, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/turtle, application/ld+json;q=0.9" },
    });
    assertNotRedirected(res, this.container);
    if (res.status === 404 || res.status === 410) {
      return [];
    }
    if (!res.ok) {
      throw new Error(`[y-solid] list ${this.container} failed: ${res.status} ${res.statusText}`);
    }
    // Size-cap the listing read: a hostile server could return an unbounded
    // listing to exhaust memory before we iterate members.
    const bytes = await readBodyCapped(res, this.maxListingBytes, this.container);
    const body = new TextDecoder().decode(bytes);
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
    const urls: string[] = [];
    // The container lists ITSELF as a member; skip it. Compare on the normalised
    // origin + pathname (ignoring any query/fragment) so a root ALIAS a hostile
    // or buggy server might list — `…/doc/?x=1`, `…/doc/#frag` — is skipped too.
    const base = new URL(this.container);
    for (const resource of container.contains) {
      // Every per-entry step is wrapped: a hostile/buggy server can list a
      // non-URL, an unparseable IRI, a foreign-origin, or an escaping member —
      // any of which must SKIP that one entry, never throw out of the listing
      // (fail closed per-entry).
      try {
        // resource.id may be relative or malformed; resolving against a valid
        // base rarely throws, but a pathological id can — hence the wrap.
        const absolute = new URL(resource.id, this.container).toString();
        const member = new URL(absolute);
        // The container lists ITSELF as a member; skip it (origin+pathname only,
        // ignoring any query/fragment a hostile server might append).
        if (member.origin === base.origin && member.pathname === base.pathname) {
          continue;
        }
        // An update resource is never a (sub-)container.
        if (isContainerUrl(absolute)) {
          continue;
        }
        // Defence in depth: never surface a member that escapes the container —
        // an attacker-controlled `ldp:contains` entry must not pull the client
        // to a foreign origin or outside the sub-tree.
        assertWithinPodScope(this.container, absolute, { allowRoot: true });
        urls.push(absolute);
      } catch {
        // Skip this one entry; keep processing the rest of the listing.
      }
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
  async readUpdate(url: string): Promise<Uint8Array | null> {
    assertWithinPodScope(this.container, url, { allowRoot: false });
    const res = await this.fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: UPDATE_CONTENT_TYPE },
    });
    assertNotRedirected(res, url);
    if (res.status === 404 || res.status === 410) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`[y-solid] readUpdate ${url} failed: ${res.status} ${res.statusText}`);
    }
    // Size-cap the read: never buffer an unbounded body from a hostile/buggy
    // server into memory.
    return readBodyCapped(res, this.maxUpdateBytes, url);
  }

  /**
   * Load the whole update log: list the container, read every member, and return
   * them in deterministic (URL-sorted) order. Members that 404/410 between the
   * listing and the read (e.g. a concurrent {@link compact}) are skipped, not
   * fatal.
   */
  async loadUpdates(): Promise<StoredUpdate[]> {
    const urls = await this.listUpdateUrls();
    const out: StoredUpdate[] = [];
    for (const url of urls) {
      const update = await this.readUpdate(url);
      if (update) out.push({ url, update });
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
  async deleteUpdate(url: string): Promise<void> {
    assertWithinPodScope(this.container, url, { allowRoot: false });
    const res = await this.fetch(url, { method: "DELETE", redirect: "manual" });
    assertNotRedirected(res, url);
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
  async compact(merged: Uint8Array, obsoleteUrls: readonly string[]): Promise<{ url: string }> {
    // Guard the to-be-deleted URLs up front (fail before writing anything if any
    // is out of scope).
    for (const url of obsoleteUrls) {
      assertWithinPodScope(this.container, url, { allowRoot: false });
    }
    const created = await this.appendUpdate(merged);
    for (const url of obsoleteUrls) {
      // Never delete the resource we just wrote (a minted name cannot collide
      // with an existing one, but guard against a caller passing it back).
      if (url === created.url) continue;
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
function toBody(update: Uint8Array): Uint8Array {
  const copy = new Uint8Array(update.byteLength);
  copy.set(update);
  return copy;
}

/**
 * Resolve a caller-supplied byte cap: a finite positive number, else the
 * default. Guards against `0`/negative/`NaN`/`Infinity` silently disabling the
 * fail-closed cap.
 */
function clampPositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
