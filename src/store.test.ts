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

describe("redirect refusal — credentialed requests never follow a 3xx", () => {
  const InScope = `${CONTAINER}update-1`;

  it("refuses a 3xx on GET (list), PUT (append), GET (read), DELETE", async () => {
    // A server that 3xx-redirects everything toward a foreign origin.
    const redirectFetch: typeof globalThis.fetch = async () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: redirectFetch });
    await expect(store.listUpdateUrls()).rejects.toThrow(/redirected/);
    await expect(store.appendUpdate(new Uint8Array([1]))).rejects.toThrow(/redirected/);
    await expect(store.readUpdate(InScope)).rejects.toThrow(/redirected/);
    await expect(store.deleteUpdate(InScope)).rejects.toThrow(/redirected/);
  });

  it("refuses a browser-style opaqueredirect (filtered response, status 0)", async () => {
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
    } as unknown as Response;
    const opaqueFetch: typeof globalThis.fetch = async () => opaque;
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: opaqueFetch });
    await expect(store.readUpdate(InScope)).rejects.toThrow(/redirected/);
    await expect(store.listUpdateUrls()).rejects.toThrow(/redirected/);
  });

  it("passes redirect:'manual' on every request (so the fetch never follows)", async () => {
    const modes: (string | undefined)[] = [];
    const spyFetch: typeof globalThis.fetch = async (_input, init) => {
      modes.push(init?.redirect);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return new Response(
          `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<${CONTAINER}> a ldp:Container .`,
          {
            status: 200,
            headers: { "content-type": "text/turtle" },
          },
        );
      }
      return new Response(null, { status: 201 });
    };
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: spyFetch });
    await store.listUpdateUrls();
    await store.appendUpdate(new Uint8Array([1]));
    await store.deleteUpdate(`${CONTAINER}x`);
    expect(modes.every((m) => m === "manual")).toBe(true);
  });
});

describe("size caps — hostile/unbounded bodies are refused", () => {
  it("refuses an update whose declared content-length exceeds maxUpdateBytes", async () => {
    const pod = makePod(CONTAINER);
    const store = new SolidUpdateStore({
      container: CONTAINER,
      fetch: pod.fetchImpl,
      maxUpdateBytes: 8,
    });
    const { url } = await store.appendUpdate(new Uint8Array(32));
    await expect(store.readUpdate(url)).rejects.toThrow(/max size/);
  });

  it("refuses an update with NO content-length once the stream passes the cap", async () => {
    // A body streamed with unknown length (no content-length): the cap must be
    // enforced on the bytes actually pulled, not just the header.
    const streamFetch: typeof globalThis.fetch = async () => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(20));
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": UPDATE_CONTENT_TYPE },
      });
    };
    const store = new SolidUpdateStore({
      container: CONTAINER,
      fetch: streamFetch,
      maxUpdateBytes: 8,
    });
    await expect(store.readUpdate(`${CONTAINER}u`)).rejects.toThrow(/max size/);
  });

  it("refuses a container listing that exceeds maxListingBytes", async () => {
    const pod = makePod(CONTAINER);
    const store = new SolidUpdateStore({
      container: CONTAINER,
      fetch: pod.fetchImpl,
      maxListingBytes: 8,
    });
    // Even the empty-container listing Turtle is > 8 bytes.
    await expect(store.listUpdateUrls()).rejects.toThrow(/max size/);
  });

  it("a bad cap value (0/NaN) falls back to the default, not an accidentally-disabled cap", async () => {
    const pod = makePod(CONTAINER);
    const store = new SolidUpdateStore({
      container: CONTAINER,
      fetch: pod.fetchImpl,
      maxUpdateBytes: 0,
      maxListingBytes: Number.NaN,
    });
    const { url } = await store.appendUpdate(new Uint8Array([1, 2, 3]));
    // The default (64 MiB) is used → a normal small read succeeds.
    expect(await store.readUpdate(url)).not.toBeNull();
    expect(await store.listUpdateUrls()).toHaveLength(1);
  });
});

describe("hostile container listing — fail closed per entry", () => {
  it("skips foreign-origin, sub-container, and non-http contains entries; keeps valid ones", async () => {
    const hostileFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url === CONTAINER) {
        const body = `@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${CONTAINER}> a ldp:Container ;
  ldp:contains <${CONTAINER}good>,
    <https://evil.example/steal>,
    <http://alice.pod/notes/my-doc/downgrade>,
    <${CONTAINER}sub/>,
    <mailto:x>,
    <${CONTAINER}../escape> .`;
        return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
      }
      return new Response(null, { status: 404 });
    };
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: hostileFetch });
    const listed = await store.listUpdateUrls();
    // Only the in-scope, non-container, http(s), same-origin member survives.
    expect(listed).toEqual([`${CONTAINER}good`]);
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
