// What an AVM1 movie's calls out to the page are let through by: the page's
// ExternalInterface, where every SWF calling it is allowed, and the URLs of
// the SWFs whose code calls it or fscommand, known by their compiled blocks
// (docs/avm1.md, "ExternalInterface").
import type { avm1 } from "@swf2es/runtime";
import type { MovieClip } from "../display/display.js";
import type { ExternalInterfaceHost } from "../hosts.js";
import type { Avm1 } from "./avm1.js";
import type { ExternalHost } from "./globals/ExternalInterface.js";
import type { Avm1Swf } from "./swf.js";

type Value = avm1.Value;

/** The page's ExternalInterface, and the SWFs that call out to the page. */
export class ExternalCalls implements ExternalHost {
  /** Each SWF's blocks, by which a function's or block's code is known as that SWF's. */
  private readonly codeSwfs = new WeakMap<avm1.Region[], Avm1Swf>();
  /** The URLs of every SWF that has had code to run, unloaded ones too. */
  private readonly codeUrls = new Set<string>();

  constructor(
    private readonly movie: Avm1,
    private readonly host: ExternalInterfaceHost | null,
  ) {}

  get realm(): avm1.Realm {
    return this.movie.realm;
  }

  /**
   * The page's ExternalInterface, where it lets the code calling use it:
   * the SWF whose block or function is running, known by its code; where
   * a native is called with no code of a SWF's running, as a timer, a
   * network callback or the page's call calls one straight, every SWF that
   * has run code so far must be allowed, as AS3's natives ask when they
   * cannot tell their caller (hosts.ts's allows). The clip a function was
   * made in is not enough: a load can put another SWF in it.
   */
  externalBridge(): ExternalInterfaceHost | null {
    const host = this.host;
    const allows = host?.allows;
    if (host === null || allows === undefined) {
      return host;
    }

    return this.callerUrls().every((url) => allows.call(host, url)) ? host : null;
  }

  /**
   * The URL of the SWF whose code is running, known by its blocks; where
   * no SWF's code is running, as a timer, a network callback or the page
   * calls a native straight, every URL of a SWF that has had code.
   */
  callerUrls(): string[] {
    const caller = this.codeSwfs.get(this.movie.realm.current?.code ?? []);
    return caller !== undefined ? [caller.url] : [...this.codeUrls];
  }

  /** `swf`'s code compiled: its blocks known as its own, and its URL among those that ran code. */
  ownCode(swf: Avm1Swf): void {
    for (const block of swf.blocks) {
      this.codeSwfs.set(block, swf);
    }

    if (swf.blocks.length > 0) {
      this.codeUrls.add(swf.url);
    }
  }

  /**
   * `body`, the page's call into a callback, run between frames or inside
   * a call out, in the root's activation as a timer's callback runs, and
   * what it queued run after it: what it returned, undefined where it did
   * not run or threw.
   */
  callIn(body: () => Value): Value {
    const movie = this.movie;
    const root = movie.root as MovieClip | null;
    const cx = root === null || movie.halted || !movie.loaded ? null : movie.activationOf(root);
    if (cx === null) {
      return undefined;
    }

    let result: Value;
    movie.timers.begin();
    try {
      movie.rt.call(cx, () => {
        result = body();
      });
      movie.queue.run();
    } finally {
      movie.timers.end();
    }

    return result;
  }
}
