// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SolidUpdateStore, UPDATE_CONTENT_TYPE } from "./store.js";
import { makePod } from "./testPod.js";

const CONTAINER = "https://alice.pod/notes/my-doc/";

function makeStore() {
  const pod = makePod(CONTAINER);
  const store = new SolidUpdateStore({ container: CONTAINER, fetch: pod.fetchImpl });
  return { pod, store };
}

describe("browser-safety", () => {
  it("the store does not import any node: module (usable in a browser Solid client)", () => {
    const src = readFileSync(fileURLToPath(new URL("./store.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/from\s+["']node:/);
    expect(src).toContain("crypto.randomUUID()");
  });
});

describe("SolidUpdateStore construction", () => {
  it("normalises the container and rejects a bad one", () => {
    const pod = makePod(CONTAINER);
    const s = new SolidUpdateStore({
      container: "https://alice.pod/notes/my-doc",
      fetch: pod.fetchImpl,
    });
    expect(s.container).toBe(CONTAINER);
    expect(() => new SolidUpdateStore({ container: "file:///x/", fetch: pod.fetchImpl })).toThrow(
      /http\(s\)/,
    );
  });
});

describe("appendUpdate + readUpdate — binary integrity", () => {
  it("round-trips arbitrary binary bytes verbatim (octet-stream)", async () => {
    const { pod, store } = makeStore();
    // Bytes spanning the full 0..255 range, incl. nulls and high bytes.
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const { url } = await store.appendUpdate(bytes);
    // Stored under the container as octet-stream.
    expect(url.startsWith(CONTAINER)).toBe(true);
    expect(pod.store.get(url)?.contentType).toBe(UPDATE_CONTENT_TYPE);
    const read = await store.readUpdate(url);
    expect(read).not.toBeNull();
    expect(Array.from(read as Uint8Array)).toEqual(Array.from(bytes));
  });

  it("does NOT alias the caller's buffer (mutating the input after append is safe)", async () => {
    const { store } = makeStore();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { url } = await store.appendUpdate(bytes);
    // Mutate the caller's buffer AFTER the append.
    bytes.fill(0);
    const read = await store.readUpdate(url);
    expect(Array.from(read as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it("readUpdate returns null for a missing resource", async () => {
    const { store } = makeStore();
    expect(await store.readUpdate(`${CONTAINER}does-not-exist`)).toBeNull();
  });
});

describe("the scope guard is enforced on every op", () => {
  it("rejects reading/deleting a foreign-origin URL", async () => {
    const { store } = makeStore();
    await expect(store.readUpdate("https://evil.example/notes/my-doc/u")).rejects.toThrow(
      /escapes container origin/,
    );
    await expect(store.deleteUpdate("https://evil.example/notes/my-doc/u")).rejects.toThrow(
      /escapes container origin/,
    );
  });

  it("rejects an escaping sibling path", async () => {
    const { store } = makeStore();
    await expect(store.readUpdate("https://alice.pod/notes/other/u")).rejects.toThrow(
      /escapes container path/,
    );
  });
});

describe("listUpdateUrls + loadUpdates — append-log ordering", () => {
  it("returns an empty log for a fresh (empty) container", async () => {
    const { store } = makeStore();
    expect(await store.listUpdateUrls()).toEqual([]);
    expect(await store.loadUpdates()).toEqual([]);
  });

  it("lists every appended update in deterministic (lexicographic) order", async () => {
    const { store } = makeStore();
    const urls: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { url } = await store.appendUpdate(new Uint8Array([i]));
      urls.push(url);
    }
    const listed = await store.listUpdateUrls();
    expect(listed).toHaveLength(5);
    // Deterministic: equals the sorted set of minted URLs.
    expect(listed).toEqual([...urls].sort());
    // The minted names are timestamp-prefixed, so they sort chronologically.
    expect(listed).toEqual([...listed].sort());
  });

  it("loadUpdates returns each update's bytes alongside its URL", async () => {
    const { store } = makeStore();
    await store.appendUpdate(new Uint8Array([10, 20]));
    await store.appendUpdate(new Uint8Array([30, 40, 50]));
    const loaded = await store.loadUpdates();
    expect(loaded).toHaveLength(2);
    const byteSets = loaded.map((u) => Array.from(u.update));
    expect(byteSets).toContainEqual([10, 20]);
    expect(byteSets).toContainEqual([30, 40, 50]);
    for (const u of loaded) expect(u.url.startsWith(CONTAINER)).toBe(true);
  });

  it("skips the container's self-listing and any sub-container", async () => {
    const { pod, store } = makeStore();
    await store.appendUpdate(new Uint8Array([1]));
    // Inject a sub-container into the backing store (a real LDP server would list it).
    pod.store.set(`${CONTAINER}sub/`, {
      body: new Uint8Array(),
      contentType: "text/turtle",
      etag: '"x"',
    });
    const listed = await store.listUpdateUrls();
    // The sub-container (trailing slash) is excluded; only the update remains.
    expect(listed.every((u) => !u.endsWith("/"))).toBe(true);
    expect(listed).toHaveLength(1);
  });
});

describe("compact — write-before-delete", () => {
  it("writes the merged resource then deletes the obsolete ones", async () => {
    const { pod, store } = makeStore();
    const a = await store.appendUpdate(new Uint8Array([1]));
    const b = await store.appendUpdate(new Uint8Array([2]));
    expect(await store.listUpdateUrls()).toHaveLength(2);

    const merged = new Uint8Array([1, 2, 99]);
    const { url } = await store.compact(merged, [a.url, b.url]);

    // The merged resource exists with the merged bytes...
    expect(Array.from(pod.store.get(url)?.body ?? [])).toEqual([1, 2, 99]);
    // ...and the originals are gone.
    expect(pod.store.has(a.url)).toBe(false);
    expect(pod.store.has(b.url)).toBe(false);
    const after = await store.listUpdateUrls();
    expect(after).toEqual([url]);
  });

  it("guards every obsolete URL before writing anything", async () => {
    const { pod, store } = makeStore();
    const before = pod.calls.putCount;
    await expect(
      store.compact(new Uint8Array([1]), ["https://evil.example/notes/my-doc/u"]),
    ).rejects.toThrow(/escapes container origin/);
    // No write happened (the guard fired before appendUpdate).
    expect(pod.calls.putCount).toBe(before);
  });
});

describe("missing container", () => {
  it("listUpdateUrls returns [] when the container 404s", async () => {
    // A fetch that 404s everything (no container present at all).
    const fetch404: typeof globalThis.fetch = async () => new Response(null, { status: 404 });
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: fetch404 });
    expect(await store.listUpdateUrls()).toEqual([]);
    expect(await store.loadUpdates()).toEqual([]);
  });
});
