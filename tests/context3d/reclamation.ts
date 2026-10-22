import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import { fixtureSource } from "./fixtures.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = fileURLToPath(new URL("out/", import.meta.url));
mkdirSync(out, { recursive: true });
libraryAbcs();
const abc = compileScripts(
  [{ name: "Reclamation", source: fixtureSource("Reclamation") }],
  out,
).get("Reclamation");
assert.ok(abc);
writeFileSync(`${out}Reclamation.swf`, bare(abc, 1, "Reclamation", 32, 32));

interface Storage {
  buffers: number;
  programs: number;
  textures: number;
  bufferBytes: number;
  textureBytes: number;
  targetDepthBytes: number;
  handles: number;
  created: number;
}
interface Status {
  alive: number;
  pending: number;
  watched: number;
  surfaces: Storage[];
  errors: string[];
}

await withPage(
  "runSwf",
  async (evaluate, send) => {
    const call = async <T>(name: string, ...args: (number | boolean)[]): Promise<T> => {
      const result = await evaluate<T>(
        `import("/repo/tests/context3d/reclamation-page.ts").then(m => m.${name}(${args.map((arg) => JSON.stringify(arg)).join(",")}))`,
      );
      assert.equal(result.exception, null, JSON.stringify(result));
      return result.value as T;
    };
    const collect = async (
      alive: number,
      accept: (status: Status) => boolean = () => true,
    ): Promise<Status> => {
      let status: Status | undefined;
      for (let i = 0; i < 8; i++) {
        await send("HeapProfiler.collectGarbage");
        const idle = await evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        assert.equal(idle.exception, null);
        status = await call<Status>("status");
        if (status.alive === alive && accept(status)) {
          return status;
        }
      }
      assert.fail(`AS resources not collected: ${JSON.stringify(status)}`);
    };
    const isIdle = (status: Status): boolean => {
      const c = status.surfaces.at(-1);
      return !!c && c.buffers === 0 && c.programs === 1 && c.textures === 0;
    };
    const idleStorage = (status: Status): void => {
      assert.deepEqual(status.errors, []);
      const c = status.surfaces.at(-1);
      assert.ok(c);
      assert.deepEqual(
        [c.buffers, c.programs, c.textures, c.bufferBytes, c.textureBytes, c.targetDepthBytes],
        [0, 1, 0, 0, 0, 0],
      );
    };
    const close = async (): Promise<void> => {
      await call("close");
      for (let i = 0; i < 8; i++) {
        await call("deliver");
        await send("HeapProfiler.collectGarbage");
        await evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        if (await call<boolean>("collected")) {
          return;
        }
      }
      assert.fail("retired resources/players/backends remain reachable");
    };
    await call("begin");
    try {
      await call("bound");
      const held = await collect(5);
      assert.deepEqual(held.errors, []);
      assert.deepEqual(
        [held.surfaces[0].buffers, held.surfaces[0].programs, held.surfaces[0].textures],
        [2, 1, 2],
      );
      await call("drawBound");
      await call("presentBack");
      const back = await collect(4, (status) => status.surfaces.at(-1)?.textures === 1);
      assert.equal(back.surfaces.at(-1)?.targetDepthBytes, 0);
      await call("drawBound");
      await call("unbind");
      idleStorage(await collect(0, isIdle));
      await call("constructionFailure");
      idleStorage(await call<Status>("status"));
      const heaps: number[] = [];
      for (let i = 0; i < 32; i++) {
        const explicit = i % 2 === 1;
        await call("churn", explicit);
        if (explicit) {
          idleStorage(await call<Status>("status"));
          idleStorage(await collect(6));
          await call("drop");
        }
        idleStorage(await collect(0, isIdle));
        if (i === 7 || i === 31) {
          const heap = await send<{ usedSize: number; backingStorageSize: number }>(
            "Runtime.getHeapUsage",
          );
          heaps.push(heap.usedSize + heap.backingStorageSize);
        }
      }
      assert.ok(heaps[1] - heaps[0] < 512 * 1024, "live-context churn retained CPU memory");
      await call("recreate");
      await call("bound");
      await collect(5);
      await call("drawBound");
      await call("lose");
      const lost = await call<Status>("status");
      assert.equal(lost.surfaces.at(-1)?.handles, 0);
      await send("HeapProfiler.collectGarbage");
      await call("restore");
      await collect(5);
      await call("drawBound");
      await call("disposeBound");
      const disposed = (await collect(0)).surfaces.at(-1);
      assert.ok(disposed);
      assert.deepEqual(
        [disposed.buffers, disposed.programs, disposed.textures, disposed.targetDepthBytes],
        [0, 0, 0, 0],
      );
    } finally {
      await close();
    }
    for (let kind = 0; kind < 5; kind++) {
      const bytes = kind >= 3;
      const resource = [0, 1, 2, 0, 2][kind];
      await call("begin", true, bytes);
      try {
        await call("drop");
        await call("unbind");
        const queued = await collect(0, (status) => status.pending >= 5);
        assert.ok(queued.pending >= 5, "did not defer collection notifications");
        await call("pressure", bytes ? kind + 2 : kind);
        const recovered = await call<Status>("status");
        const c = recovered.surfaces[0];
        assert.deepEqual(
          [c.buffers, c.programs, c.textures, c.targetDepthBytes],
          [resource === 0 ? 1 : 0, resource === 1 ? 2 : 1, resource === 2 ? 1 : 0, 0],
        );
        if (bytes) {
          assert.equal(
            resource === 0 ? c.bufferBytes : c.textureBytes,
            resource === 0 ? 131072 : 21844,
          );
        }
        await call("deliver");
        assert.deepEqual(
          (await call<Status>("status")).surfaces,
          recovered.surfaces,
          "late callbacks changed reclaimed storage",
        );
      } finally {
        await close();
      }
    }
    await call("begin", true);
    try {
      await call("drop");
      await call("unbind");
      await collect(0, (status) => status.pending >= 5);
      await call("recreate", false);
      await call("drop");
      const replaced = await collect(5);
      await call("deliver");
      assert.deepEqual((await call<Status>("status")).surfaces, replaced.surfaces);
      await call("drawBound");
      await call("unbind");
      await collect(0, (status) => status.pending >= 5);
      await call("lose", false);
      await call("restore");
      await call("drop");
      const restored = await collect(5);
      await call("deliver");
      assert.deepEqual((await call<Status>("status")).surfaces, restored.surfaces);
      await call("drawBound");
    } finally {
      await close();
    }
    console.log(
      "context3d reclamation: live AS GC, bound resources, disposal, constructor rollback, count/byte budgets, deferred callbacks and loss/recovery ok",
    );
  },
  false,
  {
    mounts: [
      ["/repo/", root],
      ["/context3d/", out],
    ],
    timeout: 180000,
  },
);
