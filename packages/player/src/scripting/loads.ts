// What a SWF asks to load, and when it comes: a Loader's SWF, from a URL
// the host fetches or from bytes, compiled and linked off the frame, in
// the order asked, and given its LoaderInfo's events in the frame after;
// a URLStream's or a Sound's bytes, and the host's other callbacks, held
// for the next frame; navigateToURL's and sendToURL's requests; and the
// LoaderInfo of each, the main SWF's too.
import { isAs3, readSwf, type Swf } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { decodeImages, hasUndecoded } from "../bitmap/images.js";
import { type Container, MovieClip, rootOf } from "../display/display.js";
import { type Library, readLibrary } from "../display/timeline.js";
import type { FetchRequest, FetchResult } from "../hosts.js";
import type { Scripting } from "../scripting.js";
import { dispatchEvent } from "./events.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/**
 * A load a Loader asked for. Its SWF's code is compiled and linked as
 * the bytes come, off the frame; what it then does on the display list
 * waits for a frame, as `ready`, or is the error it ended in.
 */
interface Load {
  loader: AsObject;
  /** The Loader's count of requests when this was asked: an older one was closed or replaced, and does nothing. */
  generation: number;
  /** The URL asked for, resolved; null for a load from bytes, which told its progress in the call. */
  url: string | null;
  bytes: Uint8Array;
  status: number;
  /** What the content's frame does: it returns what the frame's end does, INIT and COMPLETE. */
  ready: (() => () => void) | null;
  /** The IOErrorEvent text the load ended in, as Flash words one. */
  failed: string | null;
  /** The application domain its code loads into, as the Loader's context chose it when asked. */
  domain: avm2.Domain;
  /** The LoaderContext's parameters, which take the place of the URL's query; null when it set none. */
  parameters: ReadonlyMap<string, string> | null;
  /** The SWF, where the call read it already: a load from bytes. */
  swf: Swf | null;
}

/**
 * An AVM1 movie a loadBytes made, for the end of a frame: Flash makes its
 * AVM1Movie in the call and has it by the end of the frame, once its
 * images are decoded here; `failed` if they could not be.
 */
interface Avm1Load {
  load: Load;
  swf: Swf;
  library: Library;
  movie: AsObject;
  ready: boolean;
  failed: boolean;
}

export class Loads {
  /** Loads asked for and not yet completed, in order; each prepared after the one before it. */
  private readonly loads: Load[] = [];
  /** AVM1 movies from bytes, in the order asked, for the end of a frame. */
  private readonly avm1Loads: Avm1Load[] = [];
  private preparing: Promise<void> = Promise.resolve();
  /** Host requests are independent of Loader's ordered preparation chain. */
  private readonly pendingRequests = new Set<Promise<void>>();
  /** Completed host byte requests delivered at the next frame, with scripts on the player thread. */
  private readonly readyBytes: (() => void)[] = [];
  /** How many loads from bytes there have been: each gets a URL of its own under the main SWF's. */
  private dynamic = 0;
  /** The main SWF's flashvars, as the host gave them. */
  private readonly flashvars: Readonly<Record<string, string>>;
  /** What the next frame does after EXIT_FRAME, before the loads' ends: the main SWF's INIT and COMPLETE. */
  readonly frameEnds: (() => void)[] = [];

  constructor(
    private readonly s: Scripting,
    options: { parameters?: Readonly<Record<string, string>> },
  ) {
    this.flashvars = options.parameters ?? {};
  }

  /** Keep an asynchronous host task visible to settled(). */
  trackRequest(task: Promise<void>): void {
    this.pendingRequests.add(task);
    void task.then(
      () => this.pendingRequests.delete(task),
      () => this.pendingRequests.delete(task),
    );
  }

  /** Cross a host callback into the next player frame, where scripts may run. */
  deferHostEvent(deliver: () => void): void {
    this.readyBytes.push(deliver);
  }

  /**
   * A LoaderInfo for `loader` (null for the main SWF's), empty until its
   * SWF is known: what its natives read is kept on it as $ fields.
   */
  loaderInfo(loader: AsObject | null): AsObject {
    const info = this.s.rt.construct(this.s.rt.classNamed("flash.display::LoaderInfo"));
    info.$loader = loader;
    info.$content = null;
    info.$bytes = null;
    info.$swf = null;
    info.$url = null;
    info.$params = NO_PARAMETERS;
    info.$loaderURL = loader ? this.ownerUrl(loader) : this.s.url;
    info.$loaded = 0;
    info.$total = 0;
    return info;
  }

  /** The main SWF's loaderInfo.parameters: its URL's query, then the flashvars. */
  mainParameters(): ReadonlyMap<string, string> {
    const parameters = queryParameters(this.s.url);
    // A host in plain JavaScript may give other values: Flash's are strings.
    for (const [name, value] of Object.entries(this.flashvars)) {
      parameters.set(name, String(value));
    }

    return parameters;
  }

  /** What a LoaderInfo knows once its SWF is: the bytes, the header's version, frame rate and size. */
  describe(info: AsObject, bytes: Uint8Array, swf: Swf): void {
    info.$bytes = bytes;
    info.$total = bytes.length;
    info.$swf = {
      version: swf.header.version,
      frameRate: swf.frameRate,
      width: Math.round((swf.frameSize.xMax - swf.frameSize.xMin) / 20),
      height: Math.round((swf.frameSize.yMax - swf.frameSize.yMin) / 20),
      as3: isAs3(swf),
    };
  }

  /**
   * The domain a load goes into: the LoaderContext's applicationDomain, or
   * by default a new child of the domain of the code that asked, as
   * Flash's `new ApplicationDomain(ApplicationDomain.currentDomain)`.
   */
  loadDomain(applicationDomain: Value): avm2.Domain {
    const chosen: avm2.Domain | undefined = applicationDomain?.$domain;
    return chosen ?? this.s.rt.childDomain(this.s.code.codeDomain());
  }

  /**
   * The URL of the SWF a Loader belongs to, which its content's loaderURL
   * reports and its relative URLs resolve against: Flash's is the SWF whose
   * code made the Loader, which the runtime does not track, so it is the
   * SWF the Loader is on the display list of when it loads, else the main.
   */
  private ownerUrl(loader: AsObject): string {
    return rootOf(loader.$display)?.loaderInfo?.$url ?? this.s.url;
  }

  /**
   * Whose a loadBytes' content is: the SWF whose code called it. Where the
   * caller cannot be told, as from a timer, only while every SWF ever
   * loaded had one origin is it that origin's, its Loader's SWF's on the
   * display list, else the main SWF's, which then shares it; with several,
   * no one's, an opaque URL that no check allows: never the main SWF's
   * for a Loader nothing places, which an unloaded child may have made.
   */
  private bytesOwner(loader: AsObject): string {
    const caller = this.s.code.callerUrl();
    if (caller !== null) {
      return caller;
    }

    if (new Set(this.s.code.everUrls().map(originOf)).size !== 1) {
      return UNKNOWN_OWNER;
    }

    return this.ownerUrl(loader);
  }

  /**
   * A Loader's loadBytes. Flash tells the whole of the progress at once, in
   * the call, the URL still null; the content comes in a later frame, under
   * a URL of the bytes' own.
   */
  requestLoad(
    loader: AsObject,
    bytes: Uint8Array,
    domain = this.loadDomain(null),
    parameters: ReadonlyMap<string, string> | null = null,
  ): void {
    const begun = this.begin(loader, domain, parameters);
    if (!begun) {
      return;
    }

    const { info, generation } = begun;
    // The bytes' SWF is the calling SWF's, as Flash gave loadBytes content
    // the domain of the SWF that loaded it: its code is judged as that SWF's.
    info.$loaderURL = this.bytesOwner(loader);
    info.$dynamic = `${info.$loaderURL}/[[DYNAMIC]]/${++this.dynamic}`;
    info.$bytes = bytes;
    info.$total = bytes.length;
    // A listener of either event may close the Loader or load anew, which ends this load.
    this.progress(info, 0);
    if (loader.$generation !== generation) {
      return;
    }

    this.progress(info, bytes.length);
    if (loader.$generation !== generation) {
      return;
    }

    let swf: Swf | null = null;
    try {
      swf = readSwf(bytes);
    } catch {
      // Not a SWF: refused when its turn comes, as Flash refuses it in a later frame.
    }

    if (swf && !isAs3(swf)) {
      const load = this.newLoad(loader, generation, null, domain, parameters, swf);
      load.bytes = bytes;
      this.requestAvm1(load, swf);
      return;
    }

    this.enqueue(
      loader,
      generation,
      null,
      Promise.resolve({ bytes, status: 0, headers: [] }),
      domain,
      parameters,
      swf,
    );
  }

  /**
   * An AVM1 SWF from bytes. Flash makes its AVM1Movie in the call, named
   * then, and has it in the Loader at the end of the frame, after
   * EXIT_FRAME, before the next frame begins: the last asked first, INIT
   * and COMPLETE with each, as adl traces it (the `avm1-movie` case). A
   * SWF with images has them decoded first, which may take frames; one
   * whose images the decoder refuses ends in IOError #2124 there instead.
   */
  private requestAvm1(load: Load, swf: Swf): void {
    const library = this.avm1Library(swf, load.domain);
    const pending: Avm1Load = {
      load,
      swf,
      library,
      movie: this.avm1Movie(library),
      ready: false,
      failed: false,
    };
    this.avm1Loads.push(pending);
    if (!hasUndecoded(library)) {
      pending.ready = true;
      return;
    }

    this.trackRequest(
      decodeImages(library, this.s.decodeImage).then(
        () => {
          pending.ready = true;
        },
        () => {
          pending.ready = true;
          pending.failed = true;
        },
      ),
    );
  }

  /** An AVM1 SWF's library: its timelines play by themselves, with no AS3 objects but the root's. */
  private avm1Library(swf: Swf, domain: avm2.Domain): Library {
    const library = readLibrary(swf);
    library.domain = domain;
    return library;
  }

  /**
   * An AVM1 SWF's root, not yet on its first frame, as AS3 sees it: an
   * AVM1Movie, which is no InteractiveObject, so the pointer's hits on the
   * movie go to its Loader (input/pointer.ts).
   */
  private avm1Movie(library: Library): AsObject {
    const root = new MovieClip(library.root, library);
    root.avm1Root = true;
    return this.s.constructAs(root, this.s.rt.classNamed("flash.display::AVM1Movie"));
  }

  /** The AVM1 movies from bytes ready by the end of this frame, the last asked first. */
  deliverAvm1Loads(): void {
    for (let i = this.avm1Loads.length - 1; i >= 0; i--) {
      const pending = this.avm1Loads[i];
      if (!pending.ready) {
        continue;
      }

      this.avm1Loads.splice(i, 1);
      try {
        this.deliverAvm1(pending);
      } catch (error) {
        this.s.reportUncaught(error);
      }
    }
  }

  /**
   * An AVM1 movie from bytes as the Loader's content, then its INIT and
   * COMPLETE. It keeps its first frame through the next frame's advance,
   * as adl shows it, then plays at the stage's frame rate.
   */
  private deliverAvm1(pending: Avm1Load): void {
    const { load, swf, library, movie } = pending;
    if (load.generation !== load.loader.$generation) {
      return;
    }

    if (pending.failed) {
      dispatchEvent(this.s, this.loaderInfoOf(load.loader), this.ioError(this.errorText(2124)));
      return;
    }

    const end = this.complete(load, swf, library, null, movie);
    (movie.$display as MovieClip).fresh = true;
    end();
  }

  /**
   * A load begins: the one before it is dropped, pending or complete, and
   * its LoaderInfo knows nothing again, as Flash's load() does at the call
   * (Ruffle's `loader_reuse` trace), but the parameters its context gave,
   * which Flash tells from the call on. The old content's REMOVED listeners
   * may load anew themselves, and that load is then the one that counts:
   * null tells the caller so.
   */
  private begin(
    loader: AsObject,
    domain: avm2.Domain,
    parameters: ReadonlyMap<string, string> | null,
  ): { info: AsObject; generation: number } | null {
    this.closeLoad(loader);
    const generation: number = loader.$generation;
    this.dropContent(loader);
    if (loader.$generation !== generation) {
      return null;
    }

    const info = this.loaderInfoOf(loader);
    info.$loaderURL = this.ownerUrl(loader);
    info.$domain = domain;
    info.$params = parameters ?? NO_PARAMETERS;
    return { info, generation };
  }

  /** A Loader's close, and what a new load does first: a pending load does nothing when its turn comes, and its fetch is aborted. */
  closeLoad(loader: AsObject): void {
    loader.$generation = (loader.$generation ?? 0) + 1;
    loader.$abort?.abort();
    loader.$abort = null;
  }

  private progress(info: AsObject, loaded: number): void {
    info.$loaded = loaded;
    dispatchEvent(
      this.s,
      info,
      this.s.rt.construct(
        this.s.rt.classNamed("flash.events::ProgressEvent"),
        "progress",
        false,
        false,
        loaded,
        info.$total,
      ),
    );
  }

  /** A Loader's load of a URL: the host fetches it, resolved, and the load completes in a frame after the bytes arrive. */
  requestLoadUrl(
    loader: AsObject,
    request: AsObject | string,
    domain = this.loadDomain(null),
    parameters: ReadonlyMap<string, string> | null = null,
  ): void {
    const begun = this.begin(loader, domain, parameters);
    if (!begun) {
      return;
    }

    const { info, generation } = begun;
    const outgoing = this.fetchRequest(request, info.$loaderURL);
    const abort = new AbortController();
    loader.$abort = abort;
    const fetch = this.s.fetch;
    this.enqueue(
      loader,
      generation,
      outgoing.url,
      fetch ? fetch(outgoing, abort.signal) : Promise.reject(),
      domain,
      parameters,
    );
  }

  /** A URLStream's host request, delivered in a frame after the bytes arrive. */
  requestBytes(
    request: AsObject | string,
    signal: AbortSignal,
    deliver: (result: FetchResult, url: string) => void,
  ): void {
    const outgoing = this.fetchRequest(request, this.s.url);
    const fetch = this.s.fetch;
    // Attach both handlers at once; an early rejection must not be unhandled.
    const fetched = (fetch ? fetch(outgoing, signal) : Promise.reject()).then(
      (result) => result,
      () => ({ bytes: null, status: 0, headers: [] }),
    );
    const completed = fetched.then((result) => {
      this.readyBytes.push(() => deliver(result, outgoing.url));
    });
    this.trackRequest(completed);
  }

  /**
   * navigateToURL's page, resolved as a load's URL is; nothing where the
   * host opens none, or for an empty URL, which Ruffle's navigators ignore
   * rather than open the SWF's own directory. A browser navigates only by
   * GET or POST, so any other method goes as a GET, its data in the query,
   * as Flash's does from a browser.
   */
  navigateTo(request: AsObject, window: string | null): void {
    if (String(request.$url) === "") {
      return;
    }

    const post = String(request.$method ?? "GET").toUpperCase() === "POST";
    this.s.navigate?.(this.fetchRequest(request, this.s.url, post ? "POST" : "GET"), window);
  }

  /** sendToURL's request, sent by the host's fetch and its response dropped, as Flash ignores it. */
  sendTo(request: AsObject): void {
    const fetch = this.s.fetch;
    if (!fetch || !this.s.sendToUrl) {
      return;
    }

    fetch(this.fetchRequest(request, this.s.url), new AbortController().signal).catch(() => {});
  }

  /** Snapshot a URLRequest at load time, before scripts can change its data or headers. */
  private fetchRequest(request: AsObject | string, base: string, as?: string): FetchRequest {
    if (typeof request === "string") {
      return { url: resolve(this.s.base ?? base, request), method: "GET", headers: [], body: null };
    }

    let url = String(request?.$url ?? "");
    const method = as ?? String(request?.$method ?? "GET");
    const get = method.toUpperCase() === "GET";
    const post = method.toUpperCase() === "POST";
    const data = request?.$data as Value;
    let body: Uint8Array | null = null;
    if (data !== null && data !== undefined) {
      if (typeof data === "object" && this.s.rt.traitsOf(data).name === "flash.utils::ByteArray") {
        if (!get) {
          const bytes = avm2.bytesOf(this.s.rt, data);
          body = bytes.buffer.slice(0, bytes.length);
        }
      } else {
        const text = this.s.rt.toString(data);
        if (get) {
          url = appendQuery(url, text);
        } else {
          body = new TextEncoder().encode(text);
        }
      }
    }

    const headers: [string, string][] = [];
    if (post) {
      for (const header of request?.$headers?.$a ?? []) {
        headers.push([
          this.s.rt.toString(this.s.rt.getProperty(header, this.s.rt.publicName("name"))),
          this.s.rt.toString(this.s.rt.getProperty(header, this.s.rt.publicName("value"))),
        ]);
      }
    }

    if (body && !headers.some(([name]) => name.toLowerCase() === "content-type")) {
      headers.push([
        "Content-Type",
        String(request?.$contentType ?? "application/x-www-form-urlencoded"),
      ]);
    }

    return { url: resolve(this.s.base ?? base, url), method, headers, body };
  }

  /** The text a failed stream reports, using Flash Player's message and the resolved URL. */
  streamError(url: string, local = false): string {
    const text = this.errorText(2032);
    return local
      ? text.replace(/\.$/, "")
      : `${text} URL: ${resolve(this.s.base ?? this.s.url, url)}`;
  }

  /**
   * Resolves once every load asked for so far has its code linked or has
   * failed, so that a host stepping frames by hand sees each complete in
   * the frame after its request, as Flash's loadBytes does.
   */
  settled(): Promise<void> {
    return Promise.all([this.preparing, ...this.pendingRequests]).then(() => {});
  }

  private newLoad(
    loader: AsObject,
    generation: number,
    url: string | null,
    domain: avm2.Domain,
    parameters: ReadonlyMap<string, string> | null,
    swf: Swf | null,
  ): Load {
    return {
      loader,
      generation,
      url,
      domain,
      parameters,
      bytes: new Uint8Array(0),
      status: 0,
      ready: null,
      failed: null,
      swf,
    };
  }

  private enqueue(
    loader: AsObject,
    generation: number,
    url: string | null,
    bytes: Promise<FetchResult>,
    domain: avm2.Domain,
    parameters: ReadonlyMap<string, string> | null,
    swf: Swf | null = null,
  ): void {
    const load = this.newLoad(loader, generation, url, domain, parameters, swf);
    this.loads.push(load);
    // Settled at once, not when its turn in the chain comes: a rejection must find its handler.
    const fetched = bytes.then(
      (result) => result,
      () => ({ bytes: null, status: 0, headers: [] }),
    );
    this.preparing = this.preparing.then(async () => {
      const result = await fetched;
      load.status = result.status;
      if (!result.bytes) {
        load.failed = `${this.errorText(2035)} URL: ${url}`;
        return;
      }

      load.bytes = result.bytes;
      // Where a redirect took it: the SWF is that URL's, for its LoaderInfo and its checks.
      if (url !== null && result.url) {
        load.url = result.url;
      }

      try {
        load.ready = await this.prepare(load);
      } catch {
        // Bytes that are no SWF, or code that does not link.
        load.failed = this.errorText(2124);
      }
    });
  }

  /** "Error #id: message", as Flash's IOErrorEvent texts begin, debugger or not. */
  private errorText(id: number): string {
    return `Error #${id}: ${avm2.errorMessages[id]}`;
  }

  /** The SWF read and its code linked, off the frame; what the frame then does with it. */
  private async prepare(load: Load): Promise<() => () => void> {
    const swf = load.swf ?? readSwf(load.bytes);
    if (!isAs3(swf)) {
      // An AVM1 SWF from a URL: its content comes as an AS3 SWF's does.
      const library = this.avm1Library(swf, load.domain);
      await decodeImages(library, this.s.decodeImage);
      return () => this.complete(load, swf, library, null);
    }

    const library = readLibrary(swf);
    library.domain = load.domain;
    // Its images first: once its code is linked, a script in the domain can
    // make its symbols, whose bitmaps take the pixels there are then.
    await decodeImages(library, this.s.decodeImage);
    // One from bytes is the SWF's that loaded it (bytesOwner), as far as its own URL goes.
    const run = await this.s.code.link(
      swf,
      load.domain,
      load.url ?? this.loaderInfoOf(load.loader).$loaderURL ?? this.ownerUrl(load.loader),
      library,
    );
    // Bound as soon as linked, as its classes are found in the domain from
    // here: one made before the load completes, as another SWF loaded into
    // the domain completes, is its symbol's. Not a load closed or replaced
    // meanwhile, which never completes.
    if (load.generation === load.loader.$generation) {
      this.s.bind(swf, library);
    }

    return () => this.complete(load, swf, library, run);
  }

  /** A Loader's unload: a pending load dropped, its content out of the display list, its LoaderInfo empty, the Loader kept; stopped for good if `stop`, as unloadAndStop has it, else playing on as an orphan. */
  unload(loader: AsObject, stop = false): void {
    this.closeLoad(loader);
    const content: AsObject | null = loader.$content ?? null;
    this.dropContent(loader);
    this.s.rt.forgetCaches();
    if (stop && content) {
      this.s.lifecycle.stopAll(content.$display);
    }
  }

  /**
   * The content let go of, as unload() and a new load do: the Loader's and
   * the LoaderInfo's first, so an unload a listener asks for finds none,
   * then UNLOAD on the LoaderInfo with the child still attached, as Flash's
   * trace has it (the `loads-init` case), then the child out.
   */
  private dropContent(loader: AsObject): void {
    const content: AsObject | null = loader.$content ?? null;
    loader.$content = null;
    const info: AsObject | undefined = loader.$loaderInfo;
    if (info) {
      info.$content = null;
      info.$bytes = null;
      info.$swf = null;
      info.$url = null;
      info.$params = NO_PARAMETERS;
      info.$loaded = 0;
      info.$total = 0;
    }

    if (content && info) {
      dispatchEvent(this.s, info, this.s.event("unload"));
    }

    const display: Container = loader.$display;
    if (content?.$display?.parent === display) {
      this.s.lifecycle.removing(content.$display);
      display.removeChild(content.$display);
    }
  }

  /**
   * The main SWF, all of it loaded, as its LoaderInfo tells it: INIT, then
   * COMPLETE, at the end of its first frame, after EXIT_FRAME, as Flash
   * (the corpus's loaderinfo_events and delayed_symbolclass).
   */
  mainLoaded(info: AsObject): void {
    this.frameEnds.push(() => {
      dispatchEvent(this.s, info, this.s.event("init"));
      dispatchEvent(this.s, info, this.s.event("complete"));
    });
  }

  /**
   * Give the loads whose code is linked their content, oldest first, and
   * stop at one still linking: they complete in the order asked. What
   * each does at the frame's end is returned. Each delivery and each load
   * is on its own: one whose code throws, as a loaded SWF's document
   * class's constructor, is reported, and those after it still come.
   */
  completeLoads(): (() => void)[] {
    const ends: (() => void)[] = [];
    if (this.readyBytes.length !== 0) {
      for (const deliver of this.readyBytes.splice(0)) {
        try {
          deliver();
        } catch (error) {
          this.s.reportUncaught(error);
        }
      }
    }

    while (this.loads.length && (this.loads[0].ready || this.loads[0].failed)) {
      const load = this.loads.shift() as Load;
      try {
        this.completeLoad(load, ends);
      } catch (error) {
        this.s.reportUncaught(error);
      }
    }

    return ends;
  }

  private completeLoad(load: Load, ends: (() => void)[]): void {
    if (load.generation !== load.loader.$generation) {
      return;
    }

    if (load.ready) {
      ends.push(load.ready());
      return;
    }

    const info = this.loaderInfoOf(load.loader);
    if (load.url !== null) {
      dispatchEvent(this.s, info, this.s.httpStatus(load.status));
      if (load.generation !== load.loader.$generation) {
        return;
      }
    }

    dispatchEvent(this.s, info, this.ioError(load.failed ?? ""));
  }

  /** An IOErrorEvent of `text`, as a failed load ends. */
  private ioError(text: string): AsObject {
    return this.s.rt.construct(
      this.s.rt.classNamed("flash.events::IOErrorEvent"),
      "ioError",
      false,
      false,
      text,
    );
  }

  private loaderInfoOf(loader: AsObject): AsObject {
    loader.$generation ??= 0;
    loader.$loaderInfo ??= this.loaderInfo(loader);
    return loader.$loaderInfo;
  }

  /**
   * A load's content, in the frame after its bytes came, after ENTER_FRAME
   * and before FRAME_CONSTRUCTED, as Flash: the SWF's code run; its
   * document class constructed, with parent and stage null; ADDED to it
   * while it still has no parent, as Flash does; then the LoaderInfo's
   * content, and the Loader's child, with ADDED again and ADDED_TO_STAGE
   * if the loader is on the stage. Its first frame's script runs with
   * the frame's, and INIT and COMPLETE follow EXIT_FRAME.
   */
  private complete(
    load: Load,
    swf: Swf,
    library: Library,
    run: (() => void) | null,
    made: AsObject | null = null,
  ): () => void {
    const info = this.loaderInfoOf(load.loader);
    load.loader.$abort = null;
    // A listener of any of these may close the Loader or load anew, and this load then ends here.
    const live = () => load.generation === load.loader.$generation;
    if (load.url !== null) {
      // A load from bytes told these in the call; one of a URL tells them as
      // the bytes come: OPEN knowing nothing, the total, then the bytes.
      dispatchEvent(this.s, info, this.s.event("open"));
      if (!live()) {
        return () => {};
      }

      info.$total = load.bytes.length;
      this.progress(info, 0);
      if (!live()) {
        return () => {};
      }

      // Its URL's query comes with the SWF, as Flash tells it from the
      // second PROGRESS on, unless the context gave parameters.
      if (!load.parameters) {
        info.$params = queryParameters(load.url);
      }

      this.describe(info, load.bytes, swf);
      this.progress(info, load.bytes.length);
      if (!live()) {
        return () => {};
      }
    } else {
      this.describe(info, load.bytes, swf);
    }

    let object: AsObject;
    let root: MovieClip;
    if (run) {
      run();
      this.s.symbols.addFontLibrary(library);
      root = new MovieClip(library.root, library);
      root.loaderInfo = info;
      root.placeFirstFrame();
      object = this.s.constructAs(
        root,
        this.s.rt.classNamed(library.classes.get(0) ?? "flash.display::MovieClip", load.domain),
      );
      dispatchEvent(this.s, object, this.s.event("added", true));
      // The SWF's own code has run by now, its document class's constructor
      // among it, which reaches the Loader through loaderInfo.loader.
      if (!live()) {
        return () => {};
      }
    } else {
      // An AVM1 SWF: no code of its own runs, and its root is an AVM1Movie.
      object = made ?? this.avm1Movie(library);
      root = object.$display;
      root.loaderInfo = info;
      root.enterFirstFrame();
    }

    info.$url = load.url ?? info.$dynamic ?? info.$loaderURL;
    info.$content = object;
    load.loader.$content = object;
    const display: Container = load.loader.$display;
    display.addChildAt(root, display.children.length);
    this.s.lifecycle.added(root);
    return () => {
      if (!live()) {
        return;
      }

      dispatchEvent(this.s, info, this.s.event("init"));
      if (!live()) {
        return;
      }

      if (load.url !== null) {
        dispatchEvent(this.s, info, this.s.httpStatus(load.status));
      }

      // An INIT or status listener that unloads has no COMPLETE, as Flash.
      if (live()) {
        dispatchEvent(this.s, info, this.s.event("complete"));
      }
    };
  }
}

const NO_PARAMETERS: ReadonlyMap<string, string> = new Map();

/**
 * The names and values of a URL's query, as Flash reads them into
 * loaderInfo.parameters: decoded, `+` as a space, a name without `=` an
 * empty value, an empty name left out, and the last of a name kept.
 */
function queryParameters(url: string): Map<string, string> {
  const parameters = new Map<string, string>();
  const path = url.split("#", 1)[0];
  const at = path.indexOf("?");
  if (at < 0) {
    return parameters;
  }

  for (const [name, value] of new URLSearchParams(path.slice(at + 1))) {
    if (name !== "") {
      parameters.set(name, value);
    }
  }

  return parameters;
}

function appendQuery(url: string, query: string): string {
  if (!query) {
    return url;
  }

  const at = url.indexOf("#");
  const path = at < 0 ? url : url.slice(0, at);
  const fragment = at < 0 ? "" : url.slice(at);
  const separator = path.includes("?") ? (/[?&]$/.test(path) ? "" : "&") : "?";
  return path + separator + query + fragment;
}

/** What loadBytes content of no one SWF is: an opaque origin, which no same-domain check passes. */
const UNKNOWN_OWNER = "about:blank";

/** A URL's origin, or the URL where it has none to read. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * `url` against `base`, enough for a SWF's relative paths: one with a
 * scheme is itself, one from the root keeps the base's origin, and any
 * other replaces the base's last segment.
 */
function resolve(base: string, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url;
  }

  const origin = base.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i)?.[0] ?? "";
  if (url.startsWith("/")) {
    return origin + url;
  }

  return base.slice(0, base.lastIndexOf("/") + 1) + url;
}
