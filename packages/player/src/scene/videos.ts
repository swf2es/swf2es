import type { TextureHandle, Textures } from "@swf2es/render";
import type { VideoSource } from "../media/video.js";

/** Each source uploads once per changed frame, shared by its Videos in this view. */
export class Videos {
  private readonly known = new WeakMap<VideoSource, { handle: TextureHandle; version: number }>();

  constructor(private readonly textures: Textures) {}

  texture(source: VideoSource): TextureHandle | null {
    const picture = source.picture;
    if (!picture) {
      return null;
    }

    let entry = this.known.get(source);
    if (!entry || !this.textures.alive(entry.handle)) {
      entry = {
        handle: this.textures.addSource(picture.width, picture.height, picture.image),
        version: source.version,
      };
      this.known.set(source, entry);
    } else if (entry.version !== source.version) {
      this.textures.setSource(entry.handle.id, picture.width, picture.height, picture.image);
      entry.version = source.version;
    }

    this.textures.use(entry.handle.id);
    return entry.handle;
  }
}
