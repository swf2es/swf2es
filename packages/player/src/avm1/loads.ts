// What an AVM1 load brings, made ready before the frame that delivers it:
// a SWF read, its library's images decoded, or an image file's pixels,
// sniffed by their bytes and not by the URL, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) core/src/loader.rs
// (ContentType::sniff, movie_loader_data) has it: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
//
// AVM1 plays what it loads as AVM1, an ActionScript 3 SWF too: its
// timeline plays and none of its code runs, as Ruffle forces such a SWF
// to AVM1 (docs/avm1.md, "Loading movies").
//
// MovieLoads keeps loadMovie's and MovieClipLoader's loads from when they
// are asked until they are done with: each arrives between frames in the
// order asked, unloads what its clip showed and fills it, telling the
// loader's listeners as it goes.
import { readSwf, type Swf } from "@swf2es/format";
import { avm1 } from "@swf2es/runtime";
import { BitmapStore } from "../bitmap/bitmap.js";
import { decodeImageFile, decodeImages, type ImageDecode, imageFormat } from "../bitmap/images.js";
import { BitmapObject, type DisplayObject, EMPTY_TIMELINE, MovieClip } from "../display/display.js";
import {
  type BitmapPixels,
  type Library,
  readLibrary,
  type Timeline,
} from "../display/timeline.js";
import type { FetchProgress, FetchResult } from "../hosts.js";
import { warmAudioFor } from "../media/sounds.js";
import type { Avm1 } from "./avm1.js";
import { formRequest } from "./globals/LoadVars.js";
import { textFor } from "./net.js";
import { CALL, NO_BLOCKS, NORMAL, Queued } from "./queue.js";
import { Avm1Swf, readRootFrames } from "./swf.js";

type Value = avm1.Value;

/** What a load brought, by what its bytes are. */
type Arrival =
  /** Nothing came: the URL was not found, or the request failed. */
  | { type: "failed"; status: number }
  /** A SWF, read, its images decoded. */
  | { type: "swf"; swf: Swf; library: Library; size: number; status: number }
  /** A JPEG, PNG or GIF, decoded: null pixels for one the decoder could not read. */
  | { type: "image"; pixels: BitmapPixels | null; size: number; status: number }
  /** Bytes that are neither, which leave the clip empty, as Flash's error state. */
  | { type: "unknown"; status: number };

/** What `result`'s bytes are, read and decoded as far as a frame needs them. */
async function arrive(result: FetchResult, decode: ImageDecode | null): Promise<Arrival> {
  const bytes = result.bytes;
  const status = result.status;
  if (bytes === null) {
    return { type: "failed", status };
  }

  const format = imageFormat(bytes);
  if (format !== null) {
    const pixels = await decodeImageFile(bytes, format, decode);
    return { type: "image", pixels, size: bytes.length, status };
  }

  const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (signature !== "FWS" && signature !== "CWS" && signature !== "ZWS") {
    return { type: "unknown", status };
  }

  let swf: Swf;
  let library: Library;
  try {
    swf = readSwf(bytes);
    library = readLibrary(swf);
  } catch {
    return { type: "unknown", status };
  }

  await decodeImages(library, decode);
  return { type: "swf", swf, library, size: bytes.length, status };
}

/**
 * A URL's query as a SWF's root gets it, each name a variable, as
 * Ruffle's movie_loader_complete defines a movie's parameters: decoded,
 * `+` a space, a name without `=` an empty value.
 */
export function queryVariables(url: string): [name: string, value: string][] {
  const path = url.split("#", 1)[0];
  const at = path.indexOf("?");
  if (at < 0) {
    return [];
  }

  return [...new URLSearchParams(path.slice(at + 1))];
}

/** A load of loadMovie's or MovieClipLoader's, from when it is asked until it is done with. */
interface MovieLoad {
  /** The clip it fills: the target's, or a level's. */
  target: MovieClip;
  /** The MovieClipLoader whose listeners hear of it; null for loadMovie's. */
  loader: avm1.Avm1Object | null;
  /**
   * Its URL as the request goes, against the page's `base`, then where a
   * redirect took it once it arrives, as Flash's plug-in has it: what it
   * loaded's `_url`, its query variables and the URL every access check
   * asks about.
   */
  url: string;
  /**
   * Under way, or cancelled by an unload before it arrived; arrived and
   * loaded, its onLoadInit to come; or done, with nothing more to tell.
   */
  status: "pending" | "cancelled" | "loaded" | "done";
  /** Whether its target was emptied for it and onLoadStart told, as its answer began to come. */
  started: boolean;
  /** The bytes onLoadProgress has told of as they came. */
  told: number;
}

/** What a load brought, its blocks compiled where it is a SWF. */
type Arrived =
  | Exclude<Arrival, { type: "swf" }>
  | (Extract<Arrival, { type: "swf" }> & { blocks: avm1.Blocks });

/** What a load replaced or cancelled before it was read brings: nothing it reads. */
const SKIPPED: Arrived = { type: "failed", status: 0 };

/** The longest a load waits for the one asked before it, in ms, to arrive in their order. */
const ORDER_WAIT = 2000;

/** `previous` settled, or `ms` passed, whichever comes first. */
function within(previous: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([previous, passed]).finally(() => clearTimeout(timer));
}

/** What a clip unloaded or in error shows: no frames, which it never enters. */
const NO_FRAMES: Timeline = { ...EMPTY_TIMELINE, frames: [] };

/** loadMovie's and MovieClipLoader's loads, which the movie owns. */
export class MovieLoads {
  /** The loads asked, in order, until they are done with. */
  private movieLoads: MovieLoad[] = [];
  /**
   * The last load's arrival, nothing, into each clip and by each
   * MovieClipLoader, which the next one's waits for: they arrive in the
   * order asked.
   */
  private readonly arrivals = new WeakMap<object, Promise<void>>();

  constructor(
    private readonly movie: Avm1,
    private readonly decodeImage: ImageDecode | null,
  ) {}

  /**
   * loadMovie and loadMovieNum: the SWF or image at `url` into a clip, or
   * into a level, which the load makes where there is none; an empty URL
   * unloads what is there.
   */
  loadMovie(into: DisplayObject | number, url: string, form: avm1.UrlForm | null): void {
    if (typeof into === "number") {
      const level = this.movie.level(into);
      if (url !== "") {
        this.startLoad(level ?? this.movie.levelToLoad(into), url, form, null);
      } else if (level !== null) {
        this.unloadMovie(level);
      }
    } else if (into instanceof MovieClip) {
      if (url !== "") {
        this.startLoad(into, url, form, null);
      } else {
        this.unloadMovie(into);
      }
    }
  }

  /**
   * MovieClipLoader.loadClip: the SWF or image at `url` into `target`,
   * `loader`'s listeners told of it; false for a target that is no clip.
   */
  loadClip(loader: avm1.Avm1Object, target: DisplayObject, url: string): boolean {
    if (!(target instanceof MovieClip)) {
      return false;
    }

    this.startLoad(target, url, null, loader);
    return true;
  }

  /**
   * A load into `target` asked: the request goes now, and what it brings,
   * read and its code compiled, arrives between frames, each load in the
   * order asked, as Ruffle's test runner has them arrive; one whose answer
   * is slow to come holds those after it a while at most.
   */
  private startLoad(
    target: MovieClip,
    url: string,
    form: avm1.UrlForm | null,
    loader: avm1.Avm1Object | null,
  ): void {
    // A load into a clip that another is under way into replaces it, which tells nothing.
    for (const earlier of this.movieLoads) {
      if (earlier.target === target && earlier.status === "pending") {
        earlier.status = "done";
      }
    }

    const request =
      form === null
        ? { url, method: "GET" as const, headers: [], body: null }
        : formRequest(url, form.method, form.vars);
    const load: MovieLoad = {
      target,
      loader,
      url: this.movie.net.resolve(url),
      status: "pending",
      started: false,
      told: 0,
    };
    this.movieLoads.push(load);
    const arrival = this.movie.net
      .request(request, "content", undefined, this.movie.net.deferred(this.progressOf(load)))
      .then(async (result): Promise<Arrived> => {
        // One replaced or cancelled meanwhile is not read, nor its code compiled.
        if (load.status !== "pending") {
          return SKIPPED;
        }

        // What came is the final URL's: a redirect to another origin must not pass as the one asked for.
        if (result.url) {
          load.url = result.url;
        }

        const a = await arrive(result, this.decodeImage);
        if (a.type !== "swf") {
          return a;
        }

        if (load.status !== "pending") {
          return SKIPPED;
        }

        // Its sounds' device opens as it arrives, before the frame that shows it.
        warmAudioFor(this.movie.audio, a.library);
        return { ...a, blocks: await this.movie.compile(a.swf, a.library.actions ?? null) };
      })
      .catch((): Arrived => ({ type: "unknown", status: 0 }));
    // After the loads asked before it into the same clip or by the same loader, which
    // are kept by what they settle to, nothing, not by what they brought.
    const keys: object[] = loader === null ? [target] : [target, loader];
    const previous = Promise.all(keys.map((key) => this.arrivals.get(key)));
    const ordered = within(previous, ORDER_WAIT).then(() => arrival);
    const settled = ordered.then(() => {});
    for (const key of keys) {
      this.arrivals.set(key, settled);
    }

    this.movie.net.after(ordered, (arrived) => this.arrived(load, arrived));
  }

  /**
   * What a load hears as its answer comes, in a frame after each word
   * (net.deferred): its target emptied for it and onLoadStart as it
   * begins, then onLoadProgress at each piece, the target's
   * getBytesLoaded growing with it, as Flash's (adl, a server sending a
   * piece every 100 ms: onLoadStart as the answer begins, onLoadProgress
   * at each piece of 2 or 4 KB with the bytes so far and the SWF's length
   * as its header tells it, then onLoadComplete once all came, onLoadInit
   * the frame after). Only the first load into its clip and by its loader
   * is told as it comes: those after it arrive in their order, told all
   * at once.
   */
  private progressOf(load: MovieLoad): FetchProgress {
    let loaded = 0;
    let total = 0;
    // An uncompressed SWF tells its length in its header, which Flash gives as the total.
    const header = new Uint8Array(8);
    return {
      open: (_head, length) => {
        total = length;
        if (this.first(load)) {
          this.begin(load);
        }
      },
      data: (chunk) => {
        if (loaded < header.length) {
          header.set(chunk.subarray(0, header.length - loaded), loaded);
          if (
            loaded + chunk.length >= header.length &&
            String.fromCharCode(...header.subarray(0, 3)) === "FWS"
          ) {
            total = new DataView(header.buffer).getUint32(4, true);
          }
        }

        loaded += chunk.length;
        this.progressed(load, loaded, total);
      },
    };
  }

  /** Whether no load asked before `load` into its clip, or by its loader, is still under way. */
  private first(load: MovieLoad): boolean {
    for (const earlier of this.movieLoads) {
      if (earlier === load) {
        return true;
      }

      if (
        earlier.status === "pending" &&
        (earlier.target === load.target || (load.loader !== null && earlier.loader === load.loader))
      ) {
        return false;
      }
    }

    return false;
  }

  /** More of a load's bytes came, `loaded` of `total`: the target's bytes, and onLoadProgress. */
  private progressed(load: MovieLoad, loaded: number, total: number): void {
    const target = load.target;
    if (!load.started || load.status !== "pending" || this.movie.removed(target)) {
      return;
    }

    const swf = this.movie.swfOf(target);
    swf.loading = { loaded, total };
    load.told = loaded;
    this.tell(load, "onLoadProgress", [target.avm1 ?? undefined, loaded, total]);
  }

  /**
   * A load's answer began: as Ruffle's movie_loader has it, what the clip
   * showed unloads, its variables go, and onLoadStart. False where the
   * load went no further: its clip was removed, or a listener ended it.
   */
  private begin(load: MovieLoad): boolean {
    const target = load.target;
    const face = target.avm1 ?? undefined;
    if (load.status !== "pending" || this.movie.removed(target)) {
      return false;
    }

    load.started = true;
    const version = this.movie.swfOf(target).version;
    this.movie.unload(target);
    if (face !== undefined) {
      for (const p of [...face.ownProperties()]) {
        if ((p.flags & avm1.DONT_DELETE) === 0) {
          face.remove(p);
        }
      }
    }

    this.movie.fill(target, new Avm1Swf(null, null, version, load.url, 0));
    this.tell(load, "onLoadStart", [face]);
    if (load.status !== "pending" || this.movie.removed(target)) {
      load.status = "done";
      return false;
    }

    return true;
  }

  /**
   * A load's bytes arrived, between frames: begun, where it was not as
   * they came (begin); then the SWF or image takes its place, or an empty
   * one where the bytes are neither, with onLoadProgress, where the last
   * piece did not tell it, and onLoadComplete, or onLoadError where
   * nothing came. A clip removed meanwhile takes nothing, and nothing is
   * told; one a listener removes or unloads is told no more.
   */
  private arrived(load: MovieLoad, arrived: Arrived): void {
    const target = load.target;
    const face = target.avm1 ?? undefined;
    const over = () => load.status !== "pending" || this.movie.removed(target);
    // Told, and whether the load goes on.
    const told = (name: string, args: Value[]) => {
      this.tell(load, name, args);
      return !over();
    };
    if (over()) {
      // One an unload cancelled still starts, and no more (the corpus's load_cancel_*).
      if (load.status === "cancelled" && !load.started && !this.movie.removed(target)) {
        this.tell(load, "onLoadStart", [face]);
      }

      load.status = "done";
      return;
    }

    if (!load.started && !this.begin(load)) {
      load.status = "done";
      return;
    }

    // Flash's error state: no frames, none loaded, no version, and -1 bytes (the corpus's
    // movieclip_state_values).
    const error = () =>
      this.movie.fill(target, new Avm1Swf(null, null, 0, load.url, -1), NO_FRAMES);
    let going = true;
    switch (arrived.type) {
      case "failed":
        error();
        load.status = "done";
        this.tell(load, "onLoadError", [face, "URLNotFound", arrived.status]);
        return;
      case "unknown":
        error();
        going = told("onLoadProgress", [face, 0, 0]);
        break;
      case "image": {
        // An image is a movie of no version, its one frame the image at depth 1.
        const swf = new Avm1Swf(null, null, 0, load.url, arrived.size);
        this.movie.fill(target, swf);
        if (arrived.pixels !== null) {
          target.placeAtDepth(new BitmapObject(BitmapStore.of(arrived.pixels)), 1);
        }

        going =
          load.told === arrived.size || told("onLoadProgress", [face, arrived.size, arrived.size]);
        break;
      }
      case "swf": {
        const { swf: file, library, size } = arrived;
        const swf = new Avm1Swf(
          library,
          library.actions ?? null,
          file.header.version,
          load.url,
          file.header.fileLength,
          size,
        );
        swf.blocks = arrived.blocks;
        this.movie.external.ownCode(swf);
        this.movie.adopt(swf);
        readRootFrames(file, swf);
        this.movie.fill(target, swf);
        // A level's new root has the player's version, as the main timeline has, then the URL's
        // query as its variables, as a movie's parameters.
        if (face !== undefined) {
          if (this.movie.levelOf(target) !== null) {
            this.movie.defineVersion(face);
          }

          for (const [name, value] of queryVariables(load.url)) {
            face.define(name, textFor(value, swf.version), 0);
          }
        }

        // Ruffle tells a load into level 0 twice; its last piece told it where it came so.
        going =
          load.told === size ||
          ((target !== this.movie.root || told("onLoadProgress", [face, size, size])) &&
            told("onLoadProgress", [face, size, size]));
        break;
      }
    }

    if (!going) {
      load.status = "done";
      return;
    }

    load.status = "loaded";
    this.tell(load, "onLoadComplete", [face, arrived.status]);
    // No onLoadInit for one a listener removed or unloaded.
    if (this.movie.removed(target)) {
      load.status = "done";
    }
  }

  /**
   * `load`'s loader's listeners told `name`, through its broadcastMessage,
   * as a script would call it.
   */
  private tell(load: MovieLoad, name: string, args: Value[]): void {
    if (load.loader !== null && !this.movie.halted) {
      this.movie.callback(load.loader, "broadcastMessage", [name, ...args]);
    }
  }

  /**
   * Each load that has arrived done with: one that loaded has its
   * loader's onLoadInit queued, once the frame's actions of what it
   * loaded have run, with those their gotos queued, the latest load's
   * first (Ruffle's movie_clip_on_load).
   */
  loadsInitialized(): void {
    for (let i = this.movieLoads.length - 1; i >= 0; i--) {
      const load = this.movieLoads[i];
      if (load.status === "pending") {
        continue;
      }

      this.movieLoads.splice(i, 1);
      if (load.status === "loaded" && load.loader !== null) {
        this.movie.queue.enqueue(
          NORMAL,
          new Queued(
            CALL,
            this.movie.root,
            null,
            0,
            0,
            false,
            "broadcastMessage",
            NO_BLOCKS,
            load.loader,
            ["onLoadInit", load.target.avm1 ?? undefined],
          ),
        );
      }
    }
  }

  /**
   * unloadMovie: what `d` shows unloaded, its unload events, and it left
   * empty, as an empty movie of its parent's SWF; a level's or a loaded
   * movie's root's between frames, a frame later, as Ruffle's
   * avm1_unload_movie has them. A load into it under way is cancelled: it
   * tells of its start as it arrives, and no more.
   */
  unloadMovie(d: DisplayObject): void {
    if (!(d instanceof MovieClip)) {
      return;
    }

    // One under way tells of its start as it arrives; one arrived has no onLoadInit.
    for (const load of this.movieLoads) {
      if (load.target === d && load.status === "pending") {
        load.status = "cancelled";
      } else if (load.target === d && load.status === "loaded") {
        load.status = "done";
      }
    }

    if (this.movie.levelOf(d) !== null || this.movie.contents.has(d)) {
      this.movie.net.after(Promise.resolve(), () => this.unloaded(d));
    } else {
      this.unloaded(d);
    }
  }

  /** `d` unloaded and left empty. */
  private unloaded(d: MovieClip): void {
    if (this.movie.removed(d)) {
      return;
    }

    const parent = this.movie.levelOf(d) !== null ? null : d.parent;
    const swf = parent === null ? this.movie.swfOf(d) : this.movie.swfOf(parent);
    // The movie it played goes with it, and what codegen keeps of it: compiling its units again
    // copies it in again.
    const unloading = this.movie.swfOf(d);
    if (unloading.root === d) {
      this.movie.releaseCode(unloading);
    }

    this.movie.unload(d);
    this.movie.fill(
      d,
      new Avm1Swf(null, null, swf.version, parent === null ? "" : swf.url, 0),
      NO_FRAMES,
    );
  }
}
