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
/** The media type every update resource is stored with. */
export declare const UPDATE_CONTENT_TYPE = "application/octet-stream";
/**
 * Default fail-closed cap on the bytes read for a SINGLE update resource. A
 * hostile or buggy server could serve an unbounded (or chunked, content-length-
 * less) body on a member URL; reading it into memory unbounded is a DoS. 64 MiB
 * comfortably exceeds any realistic single Yjs update while bounding the read.
 * Override per store via `maxUpdateBytes`.
 */
export declare const DEFAULT_MAX_UPDATE_BYTES: number;
/**
 * Default fail-closed cap on the bytes read for the container LISTING. A hostile
 * server could return an enormous Turtle/JSON-LD listing (millions of
 * `ldp:contains` triples) to exhaust memory before we even iterate members;
 * capping the read bounds both the parse cost and the member count. 16 MiB.
 * Override per store via `maxListingBytes`.
 */
export declare const DEFAULT_MAX_LISTING_BYTES: number;
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
 * The persistence store for a single Yjs doc's update log under one container.
 *
 * Construct with an absolute container URL + an authenticated fetch. The
 * constructor rejects a non-http(s) container and normalises it to a single
 * trailing slash.
 */
export declare class SolidUpdateStore {
    /** The normalised container URL (one trailing slash). */
    readonly container: string;
    private readonly fetch;
    private readonly maxUpdateBytes;
    private readonly maxListingBytes;
    constructor(options: SolidUpdateStoreOptions);
    /**
     * Append a binary update to the log: PUT it to a freshly-minted
     * `application/octet-stream` resource under the container with
     * `If-None-Match: *` (a CONDITIONAL create — a minted-name collision fails
     * fast rather than overwriting). Returns the minted URL.
     *
     * @throws if the write is rejected (incl. a 412 collision).
     */
    appendUpdate(update: Uint8Array): Promise<{
        url: string;
    }>;
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
    listUpdateUrls(): Promise<string[]>;
    /**
     * Read a single binary update resource. Returns `null` for a missing resource
     * (404/410).
     *
     * @throws if the target is outside the container, or on any non-ok,
     *   non-404/410 response.
     */
    readUpdate(url: string): Promise<Uint8Array | null>;
    /**
     * Load the whole update log: list the container, read every member, and return
     * them in deterministic (URL-sorted) order. Members that 404/410 between the
     * listing and the read (e.g. a concurrent {@link compact}) are skipped, not
     * fatal.
     */
    loadUpdates(): Promise<StoredUpdate[]>;
    /**
     * Delete a single update resource (used by {@link compact}). A missing
     * resource (404/410) is treated as already-deleted (no throw).
     *
     * @throws if the target is outside the container, or on any other non-ok
     *   response.
     */
    deleteUpdate(url: string): Promise<void>;
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
    compact(merged: Uint8Array, obsoleteUrls: readonly string[]): Promise<{
        url: string;
    }>;
}
//# sourceMappingURL=store.d.ts.map