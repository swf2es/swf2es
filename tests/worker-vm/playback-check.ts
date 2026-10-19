import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { withPage } from "../player/chrome.ts";
import { decodePng } from "../player/image.ts";

interface Result {
  pictures: string[];
  traces: string[];
  stats: { mainSpins: number; workerRenderers: number; bitmapCalls: number; dropped?: number };
  tasks: number;
  cancelled: boolean;
}

export async function checkPlayback(out: string, gpu = false) {
  await withPage(
    "openPlayback",
    async (evaluate, _send, fresh) => {
      for (const fixture of ["playback", "playback-avm1"]) {
        let baseline: Result | undefined;
        for (const mode of ["direct", "main-renderer", "worker-renderer"]) {
          const answer = await evaluate<Result>(`(async()=>{
        const bytes=new Uint8Array(await(await fetch(${JSON.stringify(`/experiment/${fixture}.swf`)})).arrayBuffer());
        const preview=await openPlayback(bytes,${JSON.stringify(mode)});
        try {
          const pictures=[await preview.capture()];
          for(let frame=1;frame<=24;frame++) {
            await preview.step(frame*1000/24,1);
            if([1,3,6,7,8,12,16,24].includes(frame))pictures.push(await preview.capture());
          }
          let tasks=0;
          if(${JSON.stringify(mode)}!=='direct') {
            const timer=setInterval(()=>tasks++,10);
            await preview.busyWorker();clearInterval(timer);
            if(tasks<3)throw new Error('main tasks stalled during worker work');
            await preview.start();
            await new Promise(resolve=>setTimeout(resolve,100));
            const until=performance.now()+180;while(performance.now()<until){}
            await new Promise(resolve=>setTimeout(resolve,100));
            await preview.stop();
            if(!preview.stats.dropped)throw new Error('backpressure did not coalesce frames');
          }
          if(preview.stats.error)throw new Error(preview.stats.error);
          const result={pictures,traces:preview.traces.slice(0,4),stats:{...preview.stats},tasks,cancelled:false};
          if(${JSON.stringify(mode)}!=='direct') {
            const pending=preview.busyWorker();preview.close();
            try{await pending;}catch(error){result.cancelled=String(error).includes('playback closed');}
            if(!result.cancelled)throw new Error('close did not reject the pending command');
          }
          return result;
        }finally{preview.close();}
      })()`);
          assert.equal(answer.exception, null, JSON.stringify(answer));
          const result = answer.value;
          assert.ok(result);
          baseline ??= result;
          assert.equal(result.stats.mainSpins, 0);
          assert.equal(result.cancelled, mode !== "direct");
          assert.equal(result.stats.workerRenderers, mode === "worker-renderer" ? 1 : 0);
          assert.ok(result.stats.bitmapCalls >= 4);
          assert.equal(result.traces[0].split(":")[0], "constructor-pixel");
          assert.equal(Number.parseInt(result.traces[0].split(":")[1], 16) >>> 0, 0xff336699);
          assert.deepEqual(result.traces, baseline.traces, `${mode}: immediate bitmap reads`);
          assert.equal(result.pictures.length, 9);
          for (let frame = 0; frame < result.pictures.length; frame++) {
            const png = Buffer.from(result.pictures[frame].split(",")[1], "base64");
            writeFileSync(`${out}${fixture}-${mode}-${frame}.png`, png);
            const actual = decodePng(png);
            const expected = decodePng(
              Buffer.from(baseline.pictures[frame].split(",")[1], "base64"),
            );
            assert.equal(actual.width, 128);
            assert.equal(actual.height, 96);
            assert.deepEqual(actual.data, expected.data, `${mode}: displayed frame ${frame}`);
          }
          writeFileSync(`${out}${fixture}-${mode}.json`, JSON.stringify(result, null, 2));
          console.log(
            `${fixture}/${mode}: nine displayed frames and synchronous bitmap reads match; main spins zero; ${result.tasks} main tasks during worker delay`,
          );
          await fresh();
        }
      }
    },
    gpu,
    {
      mounts: [["/experiment/", out]],
      page: "experiment/playback.html?manual=1",
      timeout: 90000,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
  );
}
