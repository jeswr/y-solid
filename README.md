# @jeswr/y-solid

A **[Yjs](https://github.com/yjs/yjs) persistence provider that stores and loads a
Yjs CRDT document in a [Solid](https://solidproject.org) pod.**

Yjs is the dominant CRDT powering collaborative editors — [TipTap](https://tiptap.dev),
[BlockNote](https://www.blocknotejs.org), Monaco-collab,
[Excalidraw](https://excalidraw.com), and many more. `@jeswr/y-solid` lets any of
those apps store their collaborative document in the **user's own pod**, instead of
a vendor's database — via an **injectable authenticated `fetch`** (bring your own
Solid auth library; this package imports none).

```ts
import * as Y from "yjs";
import { SolidPersistence } from "@jeswr/y-solid";

const doc = new Y.Doc();

const provider = new SolidPersistence({
  doc,
  container: "https://alice.solidpod.example/notes/my-doc/", // a pod container
  fetch: session.fetch, // an authenticated fetch (e.g. from @solid/reactive-authentication)
});

await provider.whenSynced; // the doc is now hydrated from the pod

// Edit as normal — every local update is persisted to the pod automatically.
doc.getText("body").insert(0, "Hello, Solid!");

// Bound a Yjs editor (TipTap / BlockNote / y-monaco / …) to `doc` as usual.
```

## Installation

This package is **GitHub-installable today** (npm publish is a deferred migration). It
ships a committed, self-contained `dist/`, so it installs with **no build step** even
under `ignore-scripts=true`:

```sh
npm install github:jeswr/y-solid#main yjs
```

`yjs` is a **peerDependency** — it is *not* bundled, so you install it alongside (you
almost certainly already depend on it). Node >= 20 or any modern browser.

## What it does (P1: persistence)

- **Loads** the doc on construction: lists the pod container's update resources,
  reads each binary update, merges them, and applies the merged state to your `Y.Doc`.
  `whenSynced` resolves and a `"synced"` event fires when hydration completes.
- **Persists** every local edit: each `doc.on("update")` (an edit you make) is appended
  to the pod as a fresh binary resource. Writes are serialised so they land in order;
  a write failure surfaces on an `"error"` event without unbinding the provider.
- **Compacts** the log on demand (`provider.compact()`): folds the whole update log into
  one merged resource and deletes the rest, bounding storage.

## Design decision: an append-only update **log**, not a single snapshot

`y-solid` persists Yjs updates as an **append-only log** — each update is its **own**
`application/octet-stream` LDP resource under one container — rather than a single
last-write-wins snapshot resource. This is a deliberate choice:

| | Append-only log (chosen) | Single snapshot resource |
|---|---|---|
| **Write** | a pure *create* of a fresh resource | read → merge → write (RMW) |
| **Concurrency** | concurrent writers/tabs never clobber each other | RMW races; last write wins → data loss |
| **Offline / crash** | each queued update is one independent PUT; a partial flush leaves a valid (smaller) log | a partial write can corrupt the one snapshot |
| **Storage growth** | grows until `compact()` folds it (the GC) | bounded, but at the cost of the above |

This works because of **Yjs CRDT semantics**: applying updates in *any* order, or more
than once, converges to the same state. So the log is robust to out-of-order or
duplicate delivery, and the merge on load is order-independent and idempotent. (We still
mint **lexicographically-sortable** resource names — a zero-padded millisecond timestamp
plus a random suffix — so the load order is *deterministic* and `compact()` folds
deterministically; correctness does not depend on it.)

**The CRDT payload is binary and is stored as binary.** Yjs updates are opaque
`Uint8Array`s; `y-solid` stores them as `application/octet-stream` and does **not** invent
an RDF encoding for them. The only RDF it touches is the LDP **container listing**
(read-only), parsed via [`@jeswr/fetch-rdf`](https://github.com/jeswr/fetch-rdf) +
[`@solid/object`](https://www.npmjs.com/package/@solid/object) — never hand-built triples.

## Security: a fail-closed scope guard

Every URL the provider reads, writes, or deletes is asserted to lie **under the configured
container** before any request, via [`@jeswr/guarded-fetch`](https://github.com/jeswr/guarded-fetch)'s
consolidated pod-scope guard (`assertWithinPodScope` — same-origin, segment-boundary
path-prefixed, and the container root itself rejected for resource ops via `{ allowRoot: false }`).
A hostile or buggy server that lists a foreign-origin or path-escaping member can never make the
provider touch it: such members are skipped on read and rejected on write. The container is the
one security boundary, and the guard is applied as defence-in-depth on *every* operation
(including each minted write target). The auth seam is strict: `y-solid` performs **no**
crypto/DPoP and imports **no** concrete auth library — you inject an already-authenticated
`fetch`.

## Live cross-client sync — a documented seam (follow-up, not built here)

This release does **persistence**: it loads on init and persists local edits. It does **not**
push remote edits to other connected clients in real time. Two ways to add live sync on top,
both calling the provider's `sync()` hook:

```ts
// sync() reads any update resources appended to the pod SINCE the last load,
// applies the new ones to the doc, and returns how many it applied.
const applied = await provider.sync();
```

1. **Solid Notifications (`WebSocketChannel2023`)** — subscribe to the container; on a
   change notification, call `provider.sync()`. (See the suite's `solid-notifications`
   helper.) This is the recommended, push-based path.
2. **Polling** — call `provider.sync()` on an interval. Simple, no server support beyond
   LDP, at the cost of latency + request volume.

Wiring a notifications channel into the provider directly (so live sync is automatic) is
a tracked follow-up — see the repo issues.

## API

### `new SolidPersistence(options)`

| option | type | notes |
|---|---|---|
| `doc` | `Y.Doc` | the document to bind (required) |
| `container` | `string` | absolute pod container URL — used with `fetch` |
| `fetch` | `typeof fetch` | an authenticated fetch — used with `container` |
| `store` | `SolidUpdateStore` | *advanced*: supply a pre-built store instead of `container` + `fetch` |

Provide **either** `store`, **or** both `container` and `fetch`.

Properties / methods:

- `whenSynced: Promise<void>` — resolves when the initial load completes.
- `synced: boolean` — `true` once loaded.
- `sync(): Promise<number>` — pull + apply updates appended since the last load (the
  live-sync hook); returns the count applied.
- `compact(): Promise<{ url } | undefined>` — fold the log into one resource (GC).
- `persistFullState(): Promise<{ url }>` — append the doc's current full state as one resource.
- `flush(): Promise<void>` — await all queued background persists.
- `destroy(): void` — stop persisting (does not destroy the `Y.Doc`).
- `on("synced" | "error", listener)` / `off(...)` — event subscription.

### `SolidUpdateStore` (`@jeswr/y-solid/store`)

The lower-level persistence store, if you want to manage the update log yourself:
`appendUpdate`, `readUpdate`, `listUpdateUrls`, `loadUpdates`, `deleteUpdate`, `compact`.

### Scope helpers (re-exported from `@jeswr/guarded-fetch`)

`normalizePodBase`, `assertWithinPodScope`, `isContainerUrl`, `PodScopeError` — the fail-closed
pod-scope guard every store operation runs through.

## Development

```sh
npm run gate   # lint (Biome) + typecheck (tsc) + test (vitest) + build + check:dist + check:lockfile-transport
```

The built `dist/` is **committed** (so the package is GitHub-installable with no build step);
`check:dist` fails the gate if it drifts from a fresh build — rebuild + commit `dist/`
alongside any `src/` change.

## License

[MIT](./LICENSE) © Jesse Wright
