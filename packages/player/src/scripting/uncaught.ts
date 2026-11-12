// An error no script caught, as Flash tells it (measured in adl): an
// UncaughtErrorEvent whose `error` is the value thrown, dispatched as the
// LoaderInfo of the SWF whose code the player called, to the listeners of
// its uncaughtErrorEvents. For a loaded SWF it goes on, in the capture and
// bubbling phases, to its Loader's, then to those of the LoaderInfo of the
// SWF the Loader is on the display list of, and so on up to the main
// SWF's; a Loader that is on no list is where it ends. An ErrorEvent
// dispatched where no listener of its type hears it is told the same way,
// as the SWF's whose code dispatched it, with the event for `error`. What
// no listener prevents is the host's to report.

import { avm2 } from "@swf2es/runtime";
import { rootOf } from "../display/display.js";
import type { Library } from "../display/timeline.js";
import type { Scripting } from "../scripting.js";
import { dispatchUncaught } from "./events.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export class UncaughtErrors {
  /** Each SWF's LoaderInfo, by what its timeline and code were bound to. */
  private readonly infos = new WeakMap<Library, AsObject>();
  private main: AsObject | null = null;
  /** Whether an UncaughtErrorEvent's listeners are running: what they throw is not told again. */
  private telling = false;
  private errorEvent: AsObject | null = null;
  /** The SWF that asked for what the player is delivering (asCaller). */
  private asked: Library | null = null;

  constructor(private readonly s: Scripting) {}

  /** `info` is the LoaderInfo of the SWF `library` came from; the main SWF's is the first. */
  owns(library: Library, info: AsObject): void {
    this.infos.set(library, info);
    this.main ??= info;
  }

  /**
   * Tell of `error`, which code the player called threw: `by` the function
   * called, or the SWF it is of, if known. One of the player's own, which
   * no script could catch either, is no event's: the host's alone. So is
   * what is not supported, which only a catch of the script's own makes
   * an AS3 error: a listener that prevents every error must not hide it.
   */
  report(error: unknown, by: Value | Library = null): void {
    if (error instanceof avm2.UnsupportedError) {
      this.s.tellHost(error);
      return;
    }

    let value: Value;
    try {
      value = this.s.rt.caught(error);
    } catch {
      this.s.tellHost(error);
      return;
    }

    let library = by as Library | null;
    if (!this.infos.has(by as Library)) {
      library = this.telling ? null : this.s.code.calledLibrary(by as Value, value);
    }

    if (this.tell(value, library)) {
      this.s.tellHost(value);
    }
  }

  /** Whether `event` is an ErrorEvent, which must be heard. */
  mustBeHeard(event: AsObject): boolean {
    try {
      this.errorEvent ??= this.s.rt.classNamed("flash.events::ErrorEvent");
    } catch {
      return false;
    }

    return this.s.rt.isInstanceOf(event, this.errorEvent.$it);
  }

  /**
   * `deliver`, which gives a SWF what it asked for now, as that SWF's: an
   * ErrorEvent it dispatches that no listener hears is told to the SWF
   * that asked, as Flash tells a URLLoader's.
   */
  asCaller<A extends unknown[]>(deliver: (...args: A) => void): (...args: A) => void {
    const library = this.s.code.runningLibrary();
    return (...args) => {
      const outer = this.asked;
      this.asked = library;
      try {
        deliver(...args);
      } finally {
        this.asked = outer;
      }
    };
  }

  /**
   * Tell of `event`, an ErrorEvent no listener heard, as the SWF's whose
   * code is running, or, dispatched by the player, the one that asked for
   * what is being delivered.
   */
  unheard(event: AsObject): void {
    if (this.tell(event, this.s.code.runningLibrary() ?? this.asked)) {
      // As Flash words it: "Error #2044: Unhandled ioError:. text=…".
      const rt = this.s.rt;
      const text = rt.toString(rt.getProperty(event, rt.publicName("text")));
      const type = rt.toString(rt.getProperty(event, rt.publicName("type")));
      const error = rt.construct(
        rt.classNamed("Error"),
        `Error #2044: Unhandled ${type}:. text=${text}`,
        2044,
      );
      this.s.tellHost(error);
    }
  }

  /** Dispatch the event for `error` as `library`'s SWF's; whether the host is to report it. */
  private tell(error: Value, library: Library | null): boolean {
    // What a listener of the event throws is dropped, as in Flash, and its other listeners go on.
    if (this.telling) {
      return false;
    }

    const info = (library && this.infos.get(library)) ?? this.main;
    if (!info) {
      return true;
    }

    // The LoaderInfo, its Loader, the LoaderInfo of the SWF that Loader is shown in, and so on.
    const path: [AsObject, AsObject | undefined][] = [];
    for (let at: AsObject | null = info; at; ) {
      path.push([at, at.$uncaught]);
      const loader: AsObject | null = at.$loader;
      if (!loader) {
        break;
      }

      path.push([loader, loader.$uncaught]);
      at = rootOf(loader.$display)?.loaderInfo ?? null;
    }

    if (!path.some(([, listeners]) => listeners)) {
      return true;
    }

    this.telling = true;
    try {
      const event = this.s.rt.construct(
        this.s.rt.classNamed("flash.events::UncaughtErrorEvent"),
        "uncaughtError",
        true,
        true,
        error,
      );

      return dispatchUncaught(this.s, event, path);
    } finally {
      this.telling = false;
    }
  }
}
