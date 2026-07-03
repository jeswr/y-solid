// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
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
import { applyUpdate, encodeStateAsUpdate, mergeUpdates } from "yjs";
import { SolidUpdateStore } from "./store.js";
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
export class SolidPersistence {
    /** The bound document. */
    doc;
    /** The backing pod update-log store. */
    store;
    /** `true` once the initial load has completed. */
    synced = false;
    /** Resolves once the initial load has completed (rejects if it fails). */
    whenSynced;
    /** `true` after {@link destroy} — the provider stops persisting. */
    destroyed = false;
    listeners = new Map();
    updateHandler;
    /** Serialises background persists so updates land in order. */
    writeTail = Promise.resolve();
    /** URLs of update resources already known locally (loaded or written by us). */
    knownUrls = new Set();
    constructor(options) {
        this.doc = options.doc;
        this.store = options.store ?? this.makeStore(options);
        // Persist every LOCAL update. Updates whose origin IS this provider are our
        // own loads/syncs being applied — skip them so we never re-persist (no echo).
        this.updateHandler = (update, origin) => {
            if (this.destroyed)
                return;
            if (origin === this)
                return;
            this.enqueuePersist(update);
        };
        this.doc.on("update", this.updateHandler);
        this.whenSynced = this.load();
    }
    makeStore(options) {
        if (!options.container || !options.fetch) {
            throw new Error("[y-solid] SolidPersistence requires either `store`, or both `container` and `fetch`.");
        }
        const storeOptions = {
            container: options.container,
            fetch: options.fetch,
        };
        return new SolidUpdateStore(storeOptions);
    }
    /**
     * Read the pod's update log and apply every update to the doc as ONE
     * transaction with this provider as the origin (so the merge does not
     * re-persist). Marks {@link synced} and fires `"synced"`.
     */
    async load() {
        const stored = await this.store.loadUpdates();
        for (const { url } of stored)
            this.knownUrls.add(url);
        // Apply each update RESILIENTLY: the bytes come from a pod that may be
        // hostile or buggy, so one corrupt/forged update must be skipped + reported,
        // never abort the whole load.
        this.applyStored(stored.map((s) => s.update));
        this.synced = true;
        this.emit("synced");
    }
    /**
     * Apply a batch of (untrusted) binary updates to the doc as ONE transaction
     * with this provider as the origin (echo-free). Each `applyUpdate` is wrapped
     * individually so a single malformed/hostile update is skipped and reported on
     * the `"error"` event rather than corrupting the transaction or throwing out of
     * the load/sync path. Yjs's own CRDT decode is the only trust boundary; we do
     * not attempt to validate the bytes ourselves.
     */
    applyStored(updates) {
        if (updates.length === 0)
            return 0;
        const skipped = [];
        let applied = 0;
        this.doc.transact(() => {
            for (const update of updates) {
                try {
                    applyUpdate(this.doc, update, this);
                    applied++;
                }
                catch (cause) {
                    const error = cause instanceof Error ? cause : new Error(String(cause));
                    skipped.push(new Error(`[y-solid] skipped a corrupt update: ${error.message}`));
                }
            }
        }, this);
        // Emit AFTER the transaction commits so an error listener cannot reentrantly
        // mutate the doc mid-transaction.
        for (const error of skipped)
            this.emit("error", error);
        return applied;
    }
    /**
     * Pull updates appended to the pod SINCE the last load/sync and apply the new
     * ones — the manual hook a notifications channel or a poll loop calls to get
     * remote changes (the live-sync seam). Returns the number of new updates
     * applied. A no-op (returns 0) before the initial load completes or after
     * {@link destroy}.
     */
    async sync() {
        if (this.destroyed || !this.synced)
            return 0;
        const urls = await this.store.listUpdateUrls();
        const fresh = [];
        for (const url of urls) {
            if (this.knownUrls.has(url))
                continue;
            const update = await this.store.readUpdate(url);
            this.knownUrls.add(url);
            if (update)
                fresh.push(update);
        }
        // Resilient per-update application (a hostile pod could serve a corrupt
        // update between loads). Returns the count actually applied (skipped-corrupt
        // updates are consumed — their URLs are marked known above — but not counted).
        return this.applyStored(fresh);
    }
    /** Enqueue a persist of `update`, serialised behind any in-flight write. */
    enqueuePersist(update) {
        this.writeTail = this.writeTail
            .then(async () => {
            if (this.destroyed)
                return;
            const { url } = await this.store.appendUpdate(update);
            this.knownUrls.add(url);
        })
            .catch((cause) => {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            this.emit("error", error);
        });
    }
    /**
     * **Compact** the pod log: fold the entire current log into one merged update,
     * write it as a single fresh resource, then delete the folded resources
     * (write-before-delete — see {@link SolidUpdateStore.compact}). Bounds the log
     * size. Awaits any pending persists first so nothing in flight is dropped.
     *
     * Returns the merged resource's URL. A no-op (returns `undefined`) if the log
     * is empty or has a single member. Safe to call periodically.
     */
    async compact() {
        if (this.destroyed)
            return undefined;
        // Drain pending persists so the snapshot we read includes everything queued.
        await this.flush();
        const stored = await this.store.loadUpdates();
        if (stored.length <= 1) {
            // Nothing to compact (0 or 1 resource). Refresh knownUrls and return.
            for (const { url } of stored)
                this.knownUrls.add(url);
            return undefined;
        }
        const merged = mergeUpdates(stored.map((s) => s.update));
        const obsolete = stored.map((s) => s.url);
        const created = await this.store.compact(merged, obsolete);
        // The folded URLs are gone; only the merged one remains known.
        for (const url of obsolete)
            this.knownUrls.delete(url);
        this.knownUrls.add(created.url);
        return created;
    }
    /**
     * Encode the doc's CURRENT full state and persist it as one update resource
     * (does NOT delete the existing log). Useful to snapshot a doc that was built
     * outside this provider before any incremental updates fired.
     */
    async persistFullState() {
        const full = encodeStateAsUpdate(this.doc);
        const result = await this.store.appendUpdate(full);
        this.knownUrls.add(result.url);
        return result;
    }
    /** Await all currently-queued background persists. */
    async flush() {
        await this.writeTail;
    }
    /**
     * Stop persisting: unsubscribe from the doc and mark destroyed. Pending writes
     * already enqueued still drain (await {@link flush} first if you need them
     * persisted before tearing down). Does NOT destroy the `Y.Doc` itself — the
     * caller owns the doc's lifecycle.
     */
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.doc.off("update", this.updateHandler);
        this.listeners.clear();
    }
    /** Subscribe to a provider event. Returns an unsubscribe function. */
    on(event, listener) {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(listener);
        return () => {
            this.listeners.get(event)?.delete(listener);
        };
    }
    /** Unsubscribe a previously-registered listener. */
    off(event, listener) {
        this.listeners.get(event)?.delete(listener);
    }
    emit(event, ...args) {
        const set = this.listeners.get(event);
        if (!set)
            return;
        // Copy so a listener unsubscribing during dispatch does not skip a sibling.
        for (const listener of [...set]) {
            listener(...args);
        }
    }
}
//# sourceMappingURL=provider.js.map