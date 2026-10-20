import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

await withPage("runSwf", async (evaluate, send) => {
  const result = await evaluate<{ comparisons: number; retired: number }>(
    'import("/page/hidden-groups-page.ts").then(m => m.hiddenGroups())',
  );
  assert.equal(result.exception, null);
  assert.equal(result.value?.comparisons, 5);
  assert.equal(result.value?.retired, 96);
  await send("HeapProfiler.collectGarbage");
  const retained = await evaluate<number>(
    "hiddenGroupLifetime.refs.filter(ref => ref.deref() !== undefined).length",
  );
  assert.equal(retained.exception, null);
  assert.equal(retained.value, 0, "retired hidden Graphics remain reachable with the scene alive");
  await evaluate("hiddenGroupLifetime.close()");
  console.log(
    "hidden-groups: reveal, reparent, masks, filters, root draws, context loss and lifetime ok",
  );
});
