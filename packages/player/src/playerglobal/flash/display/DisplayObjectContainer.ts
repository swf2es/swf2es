// flash.display.DisplayObjectContainer: children by index, as AS3 sees
// them, over the player's render-ordered list.
import { avm2 } from "@swf2es/runtime";
import type { Container, DisplayObject } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";
import { displayOf } from "./DisplayObject.js";

const { plain } = avm2;
type AsObject = avm2.AsObject;
type Value = avm2.Value;

function containerOf(o: AsObject): Container {
  return displayOf(o) as Container;
}

export function containerNatives(s: Scripting): avm2.Natives {
  // s.rt at call time: the natives are made before the runtime that holds them is.
  const childOf = (v: Value): DisplayObject => {
    const d = v?.$display as DisplayObject | undefined;
    if (!d) {
      throw s.rt.error("TypeError", 2007, "child");
    }

    return d;
  };
  const ownChild = (c: Container, v: Value): DisplayObject => {
    const d = childOf(v);
    if (d.parent !== c) {
      throw s.rt.error("ArgumentError", 2025);
    }

    return d;
  };
  const indexIn = (c: Container, v: Value, max = c.children.length - 1): number => {
    const i = s.rt.toInt(v);
    if (i < 0 || i > max) {
      throw s.rt.error("RangeError", 2006);
    }

    return i;
  };
  const add = (c: Container, v: Value, index: number): Value => {
    const d = childOf(v);
    // Adding an ancestor, or itself, would make a cycle.
    for (let o: DisplayObject | null = c; o; o = o.parent) {
      if (o === d) {
        throw s.rt.error("ArgumentError", 2150);
      }
    }

    c.addChildAt(d, index);
    return v;
  };

  return {
    "flash.display::DisplayObjectContainer#get:numChildren": plain(function (this: AsObject) {
      return containerOf(this).children.length;
    }),
    "flash.display::DisplayObjectContainer#addChild": plain(function (
      this: AsObject,
      child: Value,
    ) {
      const c = containerOf(this);
      const d = childOf(child);
      // Already a child: moved to the top.
      return add(c, child, d.parent === c ? c.children.length - 1 : c.children.length);
    }),
    "flash.display::DisplayObjectContainer#addChildAt": plain(function (
      this: AsObject,
      child: Value,
      index: Value,
    ) {
      const c = containerOf(this);
      const d = childOf(child);
      return add(c, child, indexIn(c, index, c.children.length - (d.parent === c ? 1 : 0)));
    }),
    "flash.display::DisplayObjectContainer#removeChild": plain(function (
      this: AsObject,
      child: Value,
    ) {
      const c = containerOf(this);
      c.removeChild(ownChild(c, child));
      return child;
    }),
    "flash.display::DisplayObjectContainer#removeChildAt": plain(function (
      this: AsObject,
      index: Value,
    ) {
      const c = containerOf(this);
      const d = c.children[indexIn(c, index)];
      c.removeChild(d);
      return d.object;
    }),
    "flash.display::DisplayObjectContainer#removeChildren": plain(function (
      this: AsObject,
      begin: Value,
      end: Value,
    ) {
      const c = containerOf(this);
      const from = begin === undefined ? 0 : s.rt.toInt(begin);
      const to =
        end === undefined || s.rt.toInt(end) === 0x7fffffff ? c.children.length : s.rt.toInt(end);
      if (from < 0 || to > c.children.length || from > to) {
        throw s.rt.error("RangeError", 2006);
      }

      for (const d of c.children.slice(from, to)) {
        c.removeChild(d);
      }
    }),
    "flash.display::DisplayObjectContainer#getChildAt": plain(function (
      this: AsObject,
      index: Value,
    ) {
      const c = containerOf(this);
      return c.children[indexIn(c, index)].object;
    }),
    "flash.display::DisplayObjectContainer#getChildIndex": plain(function (
      this: AsObject,
      child: Value,
    ) {
      const c = containerOf(this);
      return c.children.indexOf(ownChild(c, child));
    }),
    "flash.display::DisplayObjectContainer#setChildIndex": plain(function (
      this: AsObject,
      child: Value,
      index: Value,
    ) {
      const c = containerOf(this);
      const d = ownChild(c, child);
      c.addChildAt(d, indexIn(c, index));
    }),
    "flash.display::DisplayObjectContainer#getChildByName": plain(function (
      this: AsObject,
      name: Value,
    ) {
      const key = String(name);
      return containerOf(this).children.find((d) => d.name === key)?.object ?? null;
    }),
    "flash.display::DisplayObjectContainer#contains": plain(function (
      this: AsObject,
      child: Value,
    ) {
      const c = containerOf(this);
      for (let o: DisplayObject | null = child?.$display ?? null; o; o = o.parent) {
        if (o === c) {
          return true;
        }
      }

      return false;
    }),
    "flash.display::DisplayObjectContainer#swapChildren": plain(function (
      this: AsObject,
      a: Value,
      b: Value,
    ) {
      const c = containerOf(this);
      c.swapChildren(ownChild(c, a), ownChild(c, b));
    }),
    "flash.display::DisplayObjectContainer#swapChildrenAt": plain(function (
      this: AsObject,
      a: Value,
      b: Value,
    ) {
      const c = containerOf(this);
      c.swapChildren(c.children[indexIn(c, a)], c.children[indexIn(c, b)]);
    }),
    "flash.display::DisplayObjectContainer#get:mouseChildren": plain(() => true),
    "flash.display::DisplayObjectContainer#set:mouseChildren": plain(() => undefined),
    "flash.display::DisplayObjectContainer#get:tabChildren": plain(() => true),
    "flash.display::DisplayObjectContainer#set:tabChildren": plain(() => undefined),
  };
}
