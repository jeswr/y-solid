// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { SolidPersistence } from "./provider.js";
import { SolidUpdateStore } from "./store.js";
import { makePod } from "./testPod.js";

const CONTAINER = "https://alice.pod/notes/my-doc/";

/** Wait for the next macrotask so the serialised write tail settles. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SolidPersistence — round-trip persistence", () => {
  it("persists local edits, then a FRESH doc loads the same state from the pod", async () => {
    const pod = makePod(CONTAINER);

    // --- Writer: build a doc and let the provider persist its edits. ---
    const docA = new Y.Doc();
    const writer = new SolidPersistence({ doc: docA, container: CONTAINER, fetch: pod.fetchImpl });
    await writer.whenSynced;
    expect(writer.synced).toBe(true);

    docA.getText("body").insert(0, "Hello, ");
    docA.getText("body").insert(7, "Solid!");
    const map = docA.getMap<number>("meta");
    map.set("count", 42);
    await writer.flush();

    // The pod now holds at least one binary update resource.
    const stored = [...pod.store.keys()].filter((u) => u !== CONTAINER);
    expect(stored.length).toBeGreaterThan(0);

    // --- Reader: a brand-new doc + provider over the SAME pod. ---
    const docB = new Y.Doc();
    const reader = new SolidPersistence({ doc: docB, container: CONTAINER, fetch: pod.fetchImpl });
    await reader.whenSynced;

    // The reader's doc converges to the writer's state.
    expect(docB.getText("body").toString()).toBe("Hello, Solid!");
    expect(docB.getMap<number>("meta").get("count")).toBe(42);
    // CRDT state vectors match — full convergence, not just a string compare.
    expect(Array.from(Y.encodeStateVector(docB))).toEqual(Array.from(Y.encodeStateVector(docA)));

    writer.destroy();
    reader.destroy();
  });

  it("preserves binary-update integrity for non-text types (Y.Array of mixed values)", async () => {
    const pod = makePod(CONTAINER);
    const docA = new Y.Doc();
    const p = new SolidPersistence({ doc: docA, container: CONTAINER, fetch: pod.fetchImpl });
    await p.whenSynced;
    const arr = docA.getArray<unknown>("items");
    arr.push([1, "two", { three: true }, [4, 5]]);
    await p.flush();
    p.destroy();

    const docB = new Y.Doc();
    const r = new SolidPersistence({ doc: docB, container: CONTAINER, fetch: pod.fetchImpl });
    await r.whenSynced;
    expect(docB.getArray<unknown>("items").toJSON()).toEqual([1, "two", { three: true }, [4, 5]]);
    r.destroy();
  });
});

describe("SolidPersistence — no echo on load", () => {
  it("applying the loaded state does NOT re-persist (no write during load)", async () => {
    const pod = makePod(CONTAINER);
    // Seed one update directly via a store.
    const seedDoc = new Y.Doc();
    seedDoc.getText("t").insert(0, "seed");
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: pod.fetchImpl });
    await store.appendUpdate(Y.encodeStateAsUpdate(seedDoc));

    const putsBefore = pod.calls.putCount;
    const doc = new Y.Doc();
    const provider = new SolidPersistence({ doc, container: CONTAINER, fetch: pod.fetchImpl });
    await provider.whenSynced;
    await tick();

    // The load applied the seed (origin = provider) — it must NOT have triggered
    // a new PUT.
    expect(pod.calls.putCount).toBe(putsBefore);
    expect(doc.getText("t").toString()).toBe("seed");
    provider.destroy();
  });
});

describe("SolidPersistence — append-log merge convergence", () => {
  it("merges many independent updates appended out of construction order", async () => {
    const pod = makePod(CONTAINER);
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: pod.fetchImpl });

    // Two independent docs editing the same shared structure; append their state
    // updates separately (simulating two clients each writing to the log).
    const d1 = new Y.Doc();
    d1.getMap("m").set("a", 1);
    const d2 = new Y.Doc();
    d2.getMap("m").set("b", 2);
    await store.appendUpdate(Y.encodeStateAsUpdate(d1));
    await store.appendUpdate(Y.encodeStateAsUpdate(d2));

    const merged = new Y.Doc();
    const provider = new SolidPersistence({
      doc: merged,
      container: CONTAINER,
      fetch: pod.fetchImpl,
    });
    await provider.whenSynced;
    // CRDT merge converges to BOTH clients' contributions.
    expect(merged.getMap("m").get("a")).toBe(1);
    expect(merged.getMap("m").get("b")).toBe(2);
    provider.destroy();
  });
});

describe("SolidPersistence — sync() (the live-sync seam)", () => {
  it("applies updates appended to the pod since load, without re-reading known ones", async () => {
    const pod = makePod(CONTAINER);
    const docA = new Y.Doc();
    const writer = new SolidPersistence({ doc: docA, container: CONTAINER, fetch: pod.fetchImpl });
    await writer.whenSynced;

    const docB = new Y.Doc();
    const reader = new SolidPersistence({ doc: docB, container: CONTAINER, fetch: pod.fetchImpl });
    await reader.whenSynced;
    expect(docB.getText("body").toString()).toBe("");

    // Writer makes a change AFTER the reader loaded.
    docA.getText("body").insert(0, "live");
    await writer.flush();

    // Before sync, the reader has not seen it.
    expect(docB.getText("body").toString()).toBe("");
    // sync() pulls the new update.
    const applied = await reader.sync();
    expect(applied).toBe(1);
    expect(docB.getText("body").toString()).toBe("live");

    // A second sync with no new updates applies nothing (known-URL skip).
    expect(await reader.sync()).toBe(0);

    writer.destroy();
    reader.destroy();
  });

  it("sync() is a no-op before the initial load and after destroy", async () => {
    const pod = makePod(CONTAINER);
    const doc = new Y.Doc();
    const provider = new SolidPersistence({ doc, container: CONTAINER, fetch: pod.fetchImpl });
    // Before whenSynced resolves.
    expect(await provider.sync()).toBe(0);
    await provider.whenSynced;
    provider.destroy();
    expect(await provider.sync()).toBe(0);
  });
});

describe("SolidPersistence — compaction", () => {
  it("folds the log into one resource and deletes the rest, preserving state", async () => {
    const pod = makePod(CONTAINER);
    const doc = new Y.Doc();
    const provider = new SolidPersistence({ doc, container: CONTAINER, fetch: pod.fetchImpl });
    await provider.whenSynced;

    // Several incremental edits → several log resources.
    for (let i = 0; i < 4; i++) doc.getArray("a").push([i]);
    await provider.flush();
    const before = [...pod.store.keys()].filter((u) => u !== CONTAINER);
    expect(before.length).toBeGreaterThan(1);

    const result = await provider.compact();
    expect(result).toBeDefined();
    const after = [...pod.store.keys()].filter((u) => u !== CONTAINER);
    expect(after).toHaveLength(1);

    // A fresh reader still gets the full state from the single compacted resource.
    const docB = new Y.Doc();
    const reader = new SolidPersistence({ doc: docB, container: CONTAINER, fetch: pod.fetchImpl });
    await reader.whenSynced;
    expect(docB.getArray("a").toJSON()).toEqual([0, 1, 2, 3]);

    provider.destroy();
    reader.destroy();
  });

  it("compact() is a no-op on an empty or single-member log", async () => {
    const pod = makePod(CONTAINER);
    const doc = new Y.Doc();
    const provider = new SolidPersistence({ doc, container: CONTAINER, fetch: pod.fetchImpl });
    await provider.whenSynced;
    expect(await provider.compact()).toBeUndefined();
    doc.getText("t").insert(0, "one");
    await provider.flush();
    // Exactly one resource → still a no-op.
    expect(await provider.compact()).toBeUndefined();
    provider.destroy();
  });
});

describe("SolidPersistence — corrupt-update resilience (untrusted pod bytes)", () => {
  // Bytes that are NOT a valid Yjs update — Y.applyUpdate throws on them.
  const Corrupt = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]);

  /**
   * A TRUNCATED valid update: applied directly to a LIVE doc it INTEGRATES the
   * structs (mutating the doc) and THEN throws while reading the truncated tail.
   * This is the dangerous "partial-integrate-then-throw" case Yjs cannot roll
   * back — the reason we must validate on a scratch doc first.
   */
  function partialThenThrow(): Uint8Array {
    const src = new Y.Doc();
    src.getText("t").insert(0, "PARTIAL");
    src.getMap("m").set("k", "vvvvv");
    const good = Y.encodeStateAsUpdate(src);
    return good.slice(0, good.length - 1);
  }

  it("a partial-integrate-then-throw update leaves the live doc BYTE-IDENTICAL; a valid update still applies", async () => {
    // Sanity: prove the payload really mutates-then-throws on a raw live doc.
    const probe = new Y.Doc();
    const before = Y.encodeStateAsUpdate(probe);
    expect(() => Y.applyUpdate(probe, partialThenThrow())).toThrow();
    const afterRaw = Y.encodeStateAsUpdate(probe);
    // The raw doc WAS mutated by the throwing update (no rollback) — the hazard.
    expect(Array.from(afterRaw)).not.toEqual(Array.from(before));

    const pod = makePod(CONTAINER);
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: pod.fetchImpl });
    // A valid update that MUST still apply...
    const seed = new Y.Doc();
    seed.getText("t").insert(0, "ok");
    await store.appendUpdate(Y.encodeStateAsUpdate(seed));
    // ...and the hazardous partial-then-throw update alongside it.
    pod.store.set(`${CONTAINER}000000000000000-partial`, {
      body: partialThenThrow(),
      contentType: "application/octet-stream",
      etag: '"p"',
    });

    const doc = new Y.Doc();
    // Snapshot the live doc state right before the provider's load applies anything.
    const provider = new SolidPersistence({ doc, container: CONTAINER, fetch: pod.fetchImpl });
    const onError = vi.fn();
    provider.on("error", onError);
    await provider.whenSynced;

    // The valid update applied...
    expect(doc.getText("t").toString()).toBe("ok");
    // ...and the hazardous update left NO trace: the doc's FULL encoded state
    // (structs AND pending/residual state — not just the state vector) is
    // byte-identical to a fresh doc with only the valid seed applied.
    const expected = new Y.Doc();
    Y.applyUpdate(expected, Y.encodeStateAsUpdate(seed));
    expect(Array.from(Y.encodeStateAsUpdate(doc))).toEqual(
      Array.from(Y.encodeStateAsUpdate(expected)),
    );
    // The map key from the throwing update must NOT be present.
    expect(doc.getMap("m").get("k")).toBeUndefined();
    // It was reported, not fatal.
    expect(onError).toHaveBeenCalled();
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/corrupt update/);
    provider.destroy();
  });

  it("skips a corrupt update on load, applies the valid ones, reports an error, and still syncs", async () => {
    const pod = makePod(CONTAINER);
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: pod.fetchImpl });

    // A valid seed update...
    const seed = new Y.Doc();
    seed.getText("t").insert(0, "ok");
    await store.appendUpdate(Y.encodeStateAsUpdate(seed));
    // ...plus a corrupt resource injected directly into the backing pod.
    pod.store.set(`${CONTAINER}000000000000000-corrupt`, {
      body: Corrupt,
      contentType: "application/octet-stream",
      etag: '"c"',
    });

    const doc = new Y.Doc();
    const provider = new SolidPersistence({ doc, container: CONTAINER, fetch: pod.fetchImpl });
    const onError = vi.fn();
    provider.on("error", onError);

    // The load RESOLVES (does not reject) despite the corrupt member.
    await provider.whenSynced;
    expect(provider.synced).toBe(true);
    // The valid update was applied.
    expect(doc.getText("t").toString()).toBe("ok");
    // The corrupt one was reported, not fatal.
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/corrupt update/);
    provider.destroy();
  });

  it("sync() skips a corrupt update appended after load and returns the applied count", async () => {
    const pod = makePod(CONTAINER);
    const doc = new Y.Doc();
    const provider = new SolidPersistence({ doc, container: CONTAINER, fetch: pod.fetchImpl });
    await provider.whenSynced;
    const onError = vi.fn();
    provider.on("error", onError);

    // Append one corrupt + one valid update to the pod after the initial load.
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: pod.fetchImpl });
    pod.store.set(`${CONTAINER}000000000000000-corrupt2`, {
      body: Corrupt,
      contentType: "application/octet-stream",
      etag: '"c2"',
    });
    const good = new Y.Doc();
    good.getText("t").insert(0, "live");
    await store.appendUpdate(Y.encodeStateAsUpdate(good));

    // Two fresh URLs seen, one applied (the corrupt one is consumed but skipped).
    const applied = await provider.sync();
    expect(applied).toBe(1);
    expect(doc.getText("t").toString()).toBe("live");
    expect(onError).toHaveBeenCalled();
    // The corrupt URL is now known — a second sync re-does nothing.
    expect(await provider.sync()).toBe(0);
    provider.destroy();
  });
});

describe("SolidPersistence — error handling + lifecycle", () => {
  it("emits an 'error' event when a background persist fails (does not throw out-of-band)", async () => {
    // A pod whose container GET works but whose PUT always 500s.
    const failingFetch: typeof globalThis.fetch = async (_input, init) => {
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
      return new Response(null, { status: 500 });
    };
    const doc = new Y.Doc();
    const provider = new SolidPersistence({ doc, container: CONTAINER, fetch: failingFetch });
    await provider.whenSynced;
    const onError = vi.fn();
    provider.on("error", onError);
    doc.getText("t").insert(0, "x");
    await provider.flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    provider.destroy();
  });

  it("destroy() stops persisting further local updates", async () => {
    const pod = makePod(CONTAINER);
    const doc = new Y.Doc();
    const provider = new SolidPersistence({ doc, container: CONTAINER, fetch: pod.fetchImpl });
    await provider.whenSynced;
    provider.destroy();
    const putsAfterDestroy = pod.calls.putCount;
    doc.getText("t").insert(0, "ignored");
    await tick();
    expect(pod.calls.putCount).toBe(putsAfterDestroy);
    expect(provider.destroyed).toBe(true);
  });

  it("fires a 'synced' event and resolves whenSynced", async () => {
    const pod = makePod(CONTAINER);
    const doc = new Y.Doc();
    const onSynced = vi.fn();
    const provider = new SolidPersistence({ doc, container: CONTAINER, fetch: pod.fetchImpl });
    provider.on("synced", onSynced);
    await provider.whenSynced;
    // Allow the synchronous emit to have run during load().
    expect(onSynced).toHaveBeenCalledOnce();
    provider.destroy();
  });

  it("rejects construction without a store or (container + fetch)", () => {
    const doc = new Y.Doc();
    expect(() => new SolidPersistence({ doc })).toThrow(/requires either `store`/);
  });

  it("accepts a pre-built store", async () => {
    const pod = makePod(CONTAINER);
    const store = new SolidUpdateStore({ container: CONTAINER, fetch: pod.fetchImpl });
    const doc = new Y.Doc();
    const provider = new SolidPersistence({ doc, store });
    await provider.whenSynced;
    expect(provider.store).toBe(store);
    provider.destroy();
  });
});
