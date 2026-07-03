/**
 * `SolidPersistence` — a Yjs persistence provider that binds a `Y.Doc` to a Solid
 * pod via the append-only binary update-log {@link ./store.js | SolidUpdateStore}.
 *
 * Lifecycle (mirrors the y-* provider convention — `y-indexeddb`, `y-leveldb`):
 *   1. **Construct** — bind a `Y.Doc` to a pod container (via an injectable authed
 *      `fetch`). The constructor kicks off the initial load.
 *   2. **Load** — list the container's update resources, read each binary update,
 *      and `Y.applyUpdate` them into the doc with THIS provider as the update
 *      ORIGIN, so the merge does not re-trigger persistence (no echo). On
 *      completion {@link whenSynced} resolves, {@link synced} flips to `true`, and
 *      a `"synced"` event fires.
 *   3. **Persist** — after the load, every LOCAL `doc.on("update")` (origin !==
 *      this provider) is appended to the log as a fresh `application/octet-stream`
 *      resource. Writes are serialised through a tail queue so updates land in
 *      order and an error surfaces on a `"error"` event without unbinding.
 *   4. **{@link destroy}** — unsubscribe from the doc and stop persisting.
 *
 * **Auth seam.** The provider imports NO concrete auth library; the consumer
 * injects an already-authenticated `fetch`. **Yjs is a peerDependency** — this
 * module imports it (the provider genuinely needs `applyUpdate`/`mergeUpdates`/
 * `encodeStateAsUpdate`), but it is NOT bundled.
 *
 * **Live cross-client sync is a DOCUMENTED SEAM, not built here (P1).** This
 * provider persists + loads; it does not push remote updates to other connected
 * clients in real time. To add live sync, wire a notifications channel
 * (Solid `WebSocketChannel2023` — see `@jeswr` `solid-notifications`) or a poll
 * loop that calls {@link sync} on a container-change notification: `sync()` reads
 * any update resources appended since the last load and applies the new ones.
 * See the README "Live sync" section. (Tracked as a follow-up.)
 */
import { type Doc } from "yjs";
import { SolidUpdateStore } from "./store.js";
/** Events emitted by {@link SolidPersistence}. */
export interface SolidPersistenceEvents {
    /** Fires once when the initial load completes (the doc is hydrated). */
    synced: () => void;
    /** Fires when a background persist (or a `sync()` read) fails. */
    error: (error: Error) => void;
}
/** Options for {@link SolidPersistence}. */
export interface SolidPersistenceOptions {
    /** The Yjs document to bind. */
    doc: Doc;
    /**
     * Either a ready {@link SolidUpdateStore}, OR the `{ container, fetch }` to
     * construct one. Supplying a store lets advanced callers share / pre-configure
     * it; the convenience form covers the common case.
     */
    store?: SolidUpdateStore;
    /** Container URL (when not supplying a `store`). */
    container?: string;
    /** Authenticated fetch (when not supplying a `store`). */
    fetch?: typeof globalThis.fetch;
}
/**
 * A Yjs persistence provider backed by a Solid pod update-log.
 *
 * @example
 * ```ts
 * import * as Y from "yjs";
 * import { SolidPersistence } from "@jeswr/y-solid";
 *
 * const doc = new Y.Doc();
 * const provider = new SolidPersistence({
 *   doc,
 *   container: "https://alice.pod/notes/my-doc/",
 *   fetch: session.fetch, // an authenticated fetch
 * });
 * await provider.whenSynced; // doc is now hydrated from the pod
 * doc.getText("body").insert(0, "hello"); // persisted automatically
 * ```
 */
export declare class SolidPersistence {
    /** The bound document. */
    readonly doc: Doc;
    /** The backing pod update-log store. */
    readonly store: SolidUpdateStore;
    /** `true` once the initial load has completed. */
    synced: boolean;
    /** Resolves once the initial load has completed (rejects if it fails). */
    readonly whenSynced: Promise<void>;
    /** `true` after {@link destroy} — the provider stops persisting. */
    destroyed: boolean;
    private readonly listeners;
    private readonly updateHandler;
    /** Serialises background persists so updates land in order. */
    private writeTail;
    /** URLs of update resources already known locally (loaded or written by us). */
    private readonly knownUrls;
    constructor(options: SolidPersistenceOptions);
    private makeStore;
    /**
     * Read the pod's update log and apply every update to the doc as ONE
     * transaction with this provider as the origin (so the merge does not
     * re-persist). Marks {@link synced} and fires `"synced"`.
     */
    private load;
    /**
     * Apply a batch of (untrusted) binary updates to the doc as ONE transaction
     * with this provider as the origin (echo-free). Each `applyUpdate` is wrapped
     * individually so a single malformed/hostile update is skipped and reported on
     * the `"error"` event rather than corrupting the transaction or throwing out of
     * the load/sync path. Yjs's own CRDT decode is the only trust boundary; we do
     * not attempt to validate the bytes ourselves.
     */
    private applyStored;
    /**
     * Pull updates appended to the pod SINCE the last load/sync and apply the new
     * ones — the manual hook a notifications channel or a poll loop calls to get
     * remote changes (the live-sync seam). Returns the number of new updates
     * applied. A no-op (returns 0) before the initial load completes or after
     * {@link destroy}.
     */
    sync(): Promise<number>;
    /** Enqueue a persist of `update`, serialised behind any in-flight write. */
    private enqueuePersist;
    /**
     * **Compact** the pod log: fold the entire current log into one merged update,
     * write it as a single fresh resource, then delete the folded resources
     * (write-before-delete — see {@link SolidUpdateStore.compact}). Bounds the log
     * size. Awaits any pending persists first so nothing in flight is dropped.
     *
     * Returns the merged resource's URL. A no-op (returns `undefined`) if the log
     * is empty or has a single member. Safe to call periodically.
     */
    compact(): Promise<{
        url: string;
    } | undefined>;
    /**
     * Encode the doc's CURRENT full state and persist it as one update resource
     * (does NOT delete the existing log). Useful to snapshot a doc that was built
     * outside this provider before any incremental updates fired.
     */
    persistFullState(): Promise<{
        url: string;
    }>;
    /** Await all currently-queued background persists. */
    flush(): Promise<void>;
    /**
     * Stop persisting: unsubscribe from the doc and mark destroyed. Pending writes
     * already enqueued still drain (await {@link flush} first if you need them
     * persisted before tearing down). Does NOT destroy the `Y.Doc` itself — the
     * caller owns the doc's lifecycle.
     */
    destroy(): void;
    /** Subscribe to a provider event. Returns an unsubscribe function. */
    on<K extends keyof SolidPersistenceEvents>(event: K, listener: SolidPersistenceEvents[K]): () => void;
    /** Unsubscribe a previously-registered listener. */
    off<K extends keyof SolidPersistenceEvents>(event: K, listener: SolidPersistenceEvents[K]): void;
    private emit;
}
//# sourceMappingURL=provider.d.ts.map