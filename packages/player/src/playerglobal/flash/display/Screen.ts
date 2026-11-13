// flash.display.Screen: the screens an AIR application's windows may be
// on, from the host's (AirApplication.screens, hosts.ts). As adl has them
// (AIR 51.3): `screens`, `mainScreen` and `getScreensForRectangle` make
// new Screen objects at every call, so none is ever === another; a Screen
// keeps the bounds it was made with, and gives the same two Rectangles
// each time, which a script may change without moving the screen; `new
// Screen()` is refused; and nothing is ever dispatched on one. A null
// rectangle, which crashes adl, is refused as a null parameter is elsewhere.
// AIR 51's contentsScaleFactor, safeArea, mode and modes are not declared.
import { avm2 } from "@swf2es/runtime";
import type { As3 } from "../../../as3/types.js";
import type { AirScreen, WindowBounds } from "../../../hosts.js";
import type { Scripting } from "../../../scripting.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** adl's on a desktop of true colour, for a host that names no screens. */
const COLOR_DEPTH = 32;

/**
 * Screen.colorDepth for a host's count of a screen's colour bits. AIR
 * counts the bits a pixel is kept in: 32 on a desktop of true colour (adl,
 * AIR 51.3), where a browser and Electron count the 24 of its red, green
 * and blue. A deep-colour screen, 30 to them, keeps its pixels in 32 bits
 * too. A screen of fewer colours, 16 bits or 8, is the same count to
 * both; so is one past 32.
 */
export function airColorDepth(bits: number): number {
  const depth = bits | 0;
  return depth >= 24 && depth < 32 ? 32 : depth;
}
/** A screen's size where the host knows none, as a player outside a browser. */
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

/** What a Screen object was made with, and the Rectangles it has given. */
interface ScreenState {
  screen: AirScreen;
  bounds: Value;
  visibleBounds: Value;
}

/**
 * A rectangle's number as getScreensForRectangle reads it: rounded to an
 * int, a half to the even one, each of x, y, width and height by itself.
 * What is not finite or past an int is the least one, as the conversion
 * adl's processor does leaves it.
 */
function rounded(n: number): number {
  if (!(Math.abs(n) < 0x80000000)) {
    return -0x80000000;
  }

  const down = Math.floor(n);
  const rest = n - down;
  if (rest !== 0.5) {
    return rest < 0.5 ? down : down + 1;
  }

  return down % 2 === 0 ? down : down + 1;
}

/**
 * Whether `rect`, rounded, and `bounds` share any area: touching edges
 * share none, nor does a rectangle of no width or height. Its far edges
 * are ints too, so one too wide for an int wraps to before its start.
 */
function overlaps(rect: WindowBounds, bounds: WindowBounds): boolean {
  const left = rounded(rect.x);
  const top = rounded(rect.y);
  const right = (left + rounded(rect.width)) | 0;
  const bottom = (top + rounded(rect.height)) | 0;
  if (right <= left || bottom <= top) {
    return false;
  }

  return (
    left < bounds.x + bounds.width &&
    right > bounds.x &&
    top < bounds.y + bounds.height &&
    bottom > bounds.y
  );
}

export function screenNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const states = new WeakMap<object, ScreenState>();
  const prop = (o: As3<"flash.geom::Rectangle">, name: "x" | "y" | "width" | "height") =>
    Number(s.rt.prop(o, name));
  const rectangle = (b: WindowBounds) =>
    s.rt.construct(s.rt.classNamed("flash.geom::Rectangle"), b.x, b.y, b.width, b.height);

  /** The host's screens as they are now, or one of the screen capabilities' size, all of it free. */
  const hostScreens = (): readonly AirScreen[] => {
    const screens = s.application?.screens?.();
    if (screens && screens.length > 0) {
      return screens;
    }

    const bounds = {
      x: 0,
      y: 0,
      width: s.screenCapabilities.screenResolutionX || DEFAULT_WIDTH,
      height: s.screenCapabilities.screenResolutionY || DEFAULT_HEIGHT,
    };
    return [{ bounds, visibleBounds: bounds, colorDepth: COLOR_DEPTH }];
  };

  /** A new Screen for `screen`: its public constructor throws, so it is made without it. */
  const make = (screen: AirScreen): AsObject => {
    const traits = s.rt.classNamed("flash.display::Screen").$it;
    const o = traits.instance();
    traits.proto.$init.call(o);
    states.set(o, { screen, bounds: null, visibleBounds: null });
    return o;
  };
  const stateOf = (o: object): ScreenState => states.get(o) as ScreenState;

  class ScreenNatives {
    static get screens(): Value {
      return s.rt.array(hostScreens().map(make));
    }

    static get mainScreen(): Value {
      const screens = hostScreens();
      return make(screens.find((screen) => screen.main) ?? screens[0]);
    }

    static getScreensForRectangle(rect: Value): Value {
      if (rect === null || rect === undefined) {
        throw s.rt.error("TypeError", 2007, "rect");
      }

      const r = {
        x: prop(rect, "x"),
        y: prop(rect, "y"),
        width: prop(rect, "width"),
        height: prop(rect, "height"),
      };
      return s.rt.array(
        hostScreens()
          .filter((screen) => overlaps(r, screen.bounds))
          .map(make),
      );
    }

    get bounds(): Value {
      const state = stateOf(this);
      state.bounds ??= rectangle(state.screen.bounds);
      return state.bounds;
    }

    get visibleBounds(): Value {
      const state = stateOf(this);
      state.visibleBounds ??= rectangle(state.screen.visibleBounds);
      return state.visibleBounds;
    }

    get colorDepth(): number {
      return airColorDepth(stateOf(this).screen.colorDepth);
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Screen", ScreenNatives);
  return natives;
}

/** `new Screen()`, as adl refuses it: only the player makes them. */
export const screenHooks: Record<string, avm2.ClassHook> = {
  "flash.display::Screen": {
    construct: (rt) => {
      throw rt.error("ArgumentError", 2012, "Screen$");
    },
  },
};
