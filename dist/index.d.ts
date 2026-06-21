/**
 * `@jeswr/y-solid` — a Yjs persistence provider that stores and loads a Yjs CRDT
 * document in a Solid pod.
 *
 * Yjs is the dominant CRDT powering collaborative editors (TipTap, BlockNote,
 * Monaco-collab, Excalidraw, and many more). `@jeswr/y-solid` lets any Yjs app
 * store its collaborative document in the USER'S OWN pod, via an injectable
 * authenticated `fetch` (the auth seam — bring your own Solid auth library).
 *
 * P1 = persistence (this release): an append-only **binary update-log** under one
 * pod container — each Yjs update is a separate `application/octet-stream`
 * resource, merged on load (Yjs CRDT semantics make the merge order-independent +
 * idempotent). A fail-closed scope guard confines all writes to the container.
 * Live cross-client sync (Solid notifications / polling) is a documented seam via
 * {@link SolidPersistence.sync} — see the README.
 *
 * @packageDocumentation
 */
export { SolidPersistence, type SolidPersistenceEvents, type SolidPersistenceOptions, } from "./provider.js";
export { assertWithinBase, isContainerUrl, normalizeContainer } from "./scope.js";
export { SolidUpdateStore, type SolidUpdateStoreOptions, type StoredUpdate, UPDATE_CONTENT_TYPE, } from "./store.js";
//# sourceMappingURL=index.d.ts.map