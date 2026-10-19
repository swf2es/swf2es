import { FrameWriter } from "./scene/frames.ts";
import { shareLibrary } from "./scene/libraries.ts";
import { SceneSnapshot } from "./scene/scene.ts";
import { sceneFixture } from "./scene-fixture.ts";
import type { SceneRequest, SceneResponse } from "./scene-messages.ts";

let fixture: ReturnType<typeof sceneFixture>;
let writer: FrameWriter;
let snapshot: SceneSnapshot;
const post = (message: SceneResponse) => self.postMessage(message);
self.onmessage = ({ data: request }: MessageEvent<SceneRequest>) => {
  try {
    if (request.type === "init") {
      fixture = sceneFixture();
      writer = new FrameWriter(request.frames);
      snapshot = new SceneSnapshot(fixture.assets);
      post({
        type: "libraries",
        libraries: fixture.libraries.map((entry) => ({
          id: entry.id,
          asset: shareLibrary(entry.bytes, entry.library),
        })),
      });
    } else if (request.type === "step") {
      fixture.step(request.frame);
    }

    const sequence = writer.write((bytes) => {
      if (request.type === "overwrite") {
        bytes.fill(0xee);
        return bytes.length;
      }
      return snapshot.encode(fixture.root, bytes);
    });
    if (sequence === null) {
      throw new Error("scene comparison exhausted frame slots");
    }
    post({ type: "done", id: request.id, sequence });
  } catch (error) {
    post({ type: "error", id: request.id, error: String(error) });
  }
};
