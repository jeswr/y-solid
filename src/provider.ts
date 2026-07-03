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

import { applyUpdate, Doc, encodeStateAsUpdate, mergeUpdates } from "yjs";
import { SolidUpdateStore, type SolidUpdateStoreOptions } from "./store.js";

/** Events emitted by {@link SolidPersistence}. */
export interface SolidPersistenceEvents {
  /** Fires once when the initial load completes (the doc is hydrated). */
  synced: () => void;
  /** Fires when a background persist (or a `sync()` read) fails. */
  error: (error: Error) => void;
}

type Listener = (...args: never[]) => void;

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
export class SolidPersistence {
  /** The bound document. */
  readonly doc: Doc;
  /** The backing pod update-log store. */
  readonly store: SolidUpdateStore;
  /** `true` once the initial load has completed. */
  synced = false;
  /** Resolves once the initial load has completed (rejects if it fails). */
  readonly whenSynced: Promise<void>;
  /** `true` after {@link destroy} — the provider stops persisting. */
  destroyed = false;

  private readonly listeners = new Map<keyof SolidPersistenceEvents, Set<Listener>>();
  private readonly updateHandler: (update: Uint8Array, origin: unknown) => void;
  /** Serialises background persists so updates land in order. */
  private writeTail: Promise<void> = Promise.resolve();
  /** URLs of update resources already known locally (loaded or written by us). */
  private readonly knownUrls = new Set<string>();

  constructor(options: SolidPersistenceOptions) {
    this.doc = options.doc;
    this.store = options.store ?? this.makeStore(options);

    // Persist every LOCAL update. Updates whose origin IS this provider are our
    // own loads/syncs being applied — skip them so we never re-persist (no echo).
    this.updateHandler = (update: Uint8Array, origin: unknown): void => {
      if (this.destroyed) return;
      if (origin === this) return;
      this.enqueuePersist(update);
    };
    this.doc.on("update", this.updateHandler);

    this.whenSynced = this.load();
  }

  private makeStore(options: SolidPersistenceOptions): SolidUpdateStore {
    if (!options.container || !options.fetch) {
      throw new Error(
        "[y-solid] SolidPersistence requires either `store`, or both `container` and `fetch`.",
      );
    }
    const storeOptions: SolidUpdateStoreOptions = {
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
  private async load(): Promise<void> {
    const stored = await this.store.loadUpdates();
    for (const { url } of stored) this.knownUrls.add(url);
    // Apply each update RESILIENTLY: the bytes come from a pod that may be
    // hostile or buggy, so one corrupt/forged update must be skipped + reported,
    // never abort the whole load.
    this.applyStored(stored.map((s) => s.update));
    this.synced = true;
    this.emit("synced");
  }

  /**
   * Apply a batch of (untrusted) binary updates to the live doc, echo-free.
   *
   * **Validate-on-scratch-first (load-bearing for data integrity).** Yjs
   * transactions have NO rollback: a malformed update that throws AFTER partially
   * integrating structs would leave the LIVE doc silently corrupted while we
   * "skip" it. So every untrusted update is FIRST replayed against a throwaway
   * `Y.Doc` — a malformed/forged update throws THERE (corrupting only the
   * scratch, which is discarded) and is skipped + reported on `"error"`, the live
   * doc untouched. Only updates that apply cleanly to the scratch are then
   * applied to the live doc, batched into ONE transaction with this provider as
   * the origin (so a good batch stays atomic-ish and echo-free — no N-transaction
   * fan-out, no re-persist).
   *
   * A validated update should never throw on the live doc (decoding is
   * state-independent); if one somehow does, that is a GENUINE integration error
   * — surfaced on `"error"`, never swallowed as a mere "skipped corrupt update".
   *
   * @returns the count actually applied to the live doc.
   */
  private applyStored(updates: readonly Uint8Array[]): number {
    if (updates.length === 0) return 0;
    const errors: Error[] = [];
    // 1. Validate each untrusted update against a fresh scratch doc.
    const valid: Uint8Array[] = [];
    for (const update of updates) {
      const scratch = new Doc();
      try {
        applyUpdate(scratch, update);
        valid.push(update);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        errors.push(new Error(`[y-solid] skipped a corrupt update: ${error.message}`));
      } finally {
        scratch.destroy();
      }
    }
    // 2. Apply the validated updates to the LIVE doc as one echo-free transaction.
    let applied = 0;
    if (valid.length > 0) {
      try {
        this.doc.transact(() => {
          for (const update of valid) {
            applyUpdate(this.doc, update, this);
            applied++;
          }
        }, this);
      } catch (cause) {
        // A scratch-validated update threw on the live doc — genuinely
        // unexpected. Surface it (do NOT swallow it as "skipped").
        const error = cause instanceof Error ? cause : new Error(String(cause));
        errors.push(
          new Error(
            `[y-solid] failed to integrate a validated update into the doc: ${error.message}`,
          ),
        );
      }
    }
    // Emit AFTER the transaction commits so an error listener cannot reentrantly
    // mutate the doc mid-transaction.
    for (const error of errors) this.emit("error", error);
    return applied;
  }

  /**
   * Pull updates appended to the pod SINCE the last load/sync and apply the new
   * ones — the manual hook a notifications channel or a poll loop calls to get
   * remote changes (the live-sync seam). Returns the number of new updates
   * applied. A no-op (returns 0) before the initial load completes or after
   * {@link destroy}.
   */
  async sync(): Promise<number> {
    if (this.destroyed || !this.synced) return 0;
    const urls = await this.store.listUpdateUrls();
    const fresh: Uint8Array[] = [];
    for (const url of urls) {
      if (this.knownUrls.has(url)) continue;
      const update = await this.store.readUpdate(url);
      this.knownUrls.add(url);
      if (update) fresh.push(update);
    }
    // Resilient per-update application (a hostile pod could serve a corrupt
    // update between loads). Returns the count actually applied (skipped-corrupt
    // updates are consumed — their URLs are marked known above — but not counted).
    return this.applyStored(fresh);
  }

  /** Enqueue a persist of `update`, serialised behind any in-flight write. */
  private enqueuePersist(update: Uint8Array): void {
    this.writeTail = this.writeTail
      .then(async () => {
        if (this.destroyed) return;
        const { url } = await this.store.appendUpdate(update);
        this.knownUrls.add(url);
      })
      .catch((cause: unknown) => {
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
  async compact(): Promise<{ url: string } | undefined> {
    if (this.destroyed) return undefined;
    // Drain pending persists so the snapshot we read includes everything queued.
    await this.flush();
    const stored = await this.store.loadUpdates();
    if (stored.length <= 1) {
      // Nothing to compact (0 or 1 resource). Refresh knownUrls and return.
      for (const { url } of stored) this.knownUrls.add(url);
      return undefined;
    }
    const merged = mergeUpdates(stored.map((s) => s.update));
    const obsolete = stored.map((s) => s.url);
    const created = await this.store.compact(merged, obsolete);
    // The folded URLs are gone; only the merged one remains known.
    for (const url of obsolete) this.knownUrls.delete(url);
    this.knownUrls.add(created.url);
    return created;
  }

  /**
   * Encode the doc's CURRENT full state and persist it as one update resource
   * (does NOT delete the existing log). Useful to snapshot a doc that was built
   * outside this provider before any incremental updates fired.
   */
  async persistFullState(): Promise<{ url: string }> {
    const full = encodeStateAsUpdate(this.doc);
    const result = await this.store.appendUpdate(full);
    this.knownUrls.add(result.url);
    return result;
  }

  /** Await all currently-queued background persists. */
  async flush(): Promise<void> {
    await this.writeTail;
  }

  /**
   * Stop persisting: unsubscribe from the doc and mark destroyed. Pending writes
   * already enqueued still drain (await {@link flush} first if you need them
   * persisted before tearing down). Does NOT destroy the `Y.Doc` itself — the
   * caller owns the doc's lifecycle.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.doc.off("update", this.updateHandler);
    this.listeners.clear();
  }

  /** Subscribe to a provider event. Returns an unsubscribe function. */
  on<K extends keyof SolidPersistenceEvents>(
    event: K,
    listener: SolidPersistenceEvents[K],
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener);
    return () => {
      this.listeners.get(event)?.delete(listener as Listener);
    };
  }

  /** Unsubscribe a previously-registered listener. */
  off<K extends keyof SolidPersistenceEvents>(event: K, listener: SolidPersistenceEvents[K]): void {
    this.listeners.get(event)?.delete(listener as Listener);
  }

  private emit<K extends keyof SolidPersistenceEvents>(
    event: K,
    ...args: Parameters<SolidPersistenceEvents[K]>
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy so a listener unsubscribing during dispatch does not skip a sibling.
    for (const listener of [...set]) {
      (listener as (...a: Parameters<SolidPersistenceEvents[K]>) => void)(...args);
    }
  }
}
