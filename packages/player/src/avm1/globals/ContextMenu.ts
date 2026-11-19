// ContextMenu and ContextMenuItem, AS2's menu of a clip, a button or the
// root, as adl and Flash Player 32 have them: a menu's onSelect, its
// builtInItems, which a copy shares, and its customItems, which a copy
// copies one by one with each item's copy; an item's caption, onSelect,
// separatorBefore, enabled and visible, kept as given. Their methods are
// SWF 7's. A right click reads the menu of what is under it (menuAt).
import { avm1 } from "@swf2es/runtime";
import type { DisplayObject } from "../../display/display.js";

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE | avm1.VERSION_7;

/** The built-in items, in the order Flash lists them. */
const BUILT_IN = ["save", "zoom", "quality", "play", "loop", "rewind", "forward_back", "print"];

/** The two classes. */
export interface ContextMenus {
  ContextMenu: avm1.Avm1Function;
  ContextMenuItem: avm1.Avm1Function;
}

/** `ContextMenu` and `ContextMenuItem`. */
export function contextMenuClasses(realm: avm1.Realm): ContextMenus {
  const itemProto = new avm1.Avm1Object(realm.objectProto);
  // Each of its own, in Flash's order: for..in lists the last first.
  const item = (
    self: avm1.Avm1Object,
    caption: avm1.Value,
    onSelect: avm1.Value,
    separatorBefore: avm1.Value,
    enabled: avm1.Value,
    visible: avm1.Value,
  ) => {
    self.define("caption", caption, 0);
    self.define("onSelect", onSelect, 0);
    self.define("separatorBefore", separatorBefore, 0);
    self.define("enabled", enabled, 0);
    self.define("visible", visible, 0);
    return self;
  };
  const ContextMenuItem = realm.classOf(
    itemProto,
    (self, args, v) =>
      item(
        self,
        args[0],
        args[1],
        args.length > 2 ? avm1.toBoolean(args[2], v) : false,
        args.length > 3 ? avm1.toBoolean(args[3], v) : true,
        args.length > 4 ? avm1.toBoolean(args[4], v) : true,
      ),
    () => undefined,
  );
  itemProto.define(
    "copy",
    realm.method((self, _, v) =>
      item(
        new avm1.Avm1Object(itemProto),
        avm1.get(self, "caption", v),
        avm1.get(self, "onSelect", v),
        avm1.get(self, "separatorBefore", v),
        avm1.get(self, "enabled", v),
        avm1.get(self, "visible", v),
      ),
    ),
    FIXED,
  );

  const menuProto = new avm1.Avm1Object(realm.objectProto);
  const menu = (
    self: avm1.Avm1Object,
    onSelect: avm1.Value,
    builtIn: avm1.Avm1Object,
    custom: avm1.Avm1Object,
  ) => {
    self.define("onSelect", onSelect, 0);
    self.define("builtInItems", builtIn, 0);
    self.define("customItems", custom, 0);
    return self;
  };
  const ContextMenu = realm.classOf(
    menuProto,
    (self, args, v) => {
      const builtIn = realm.newObject(v);
      for (let i = BUILT_IN.length - 1; i >= 0; i--) {
        builtIn.define(BUILT_IN[i], true, 0);
      }

      return menu(self, args[0], builtIn, realm.newArray([], v));
    },
    () => undefined,
  );
  menuProto.define(
    "copy",
    realm.method((self, _, v) => {
      const builtIn = avm1.get(self, "builtInItems", v);
      const custom = avm1.get(self, "customItems", v);
      const copies: avm1.Value[] = [];
      if (custom instanceof avm1.Avm1Object) {
        const length = avm1.toNumber(avm1.get(custom, "length", v), v);
        for (let i = 0; i < length; i++) {
          const element = avm1.get(custom, String(i), v);
          copies.push(
            element instanceof avm1.Avm1Object
              ? avm1.invoke(avm1.get(element, "copy", v), element, [], v)
              : undefined,
          );
        }
      }

      return menu(
        new avm1.Avm1Object(menuProto),
        avm1.get(self, "onSelect", v),
        builtIn instanceof avm1.Avm1Object ? builtIn : realm.newObject(v),
        realm.newArray(copies, v),
      );
    }),
    FIXED,
  );
  menuProto.define(
    "hideBuiltInItems",
    realm.method((self, _, v) => {
      const builtIn = avm1.get(self, "builtInItems", v);
      if (builtIn instanceof avm1.Avm1Object) {
        for (const name of BUILT_IN) {
          avm1.set(builtIn, name, false, v);
        }
      }

      return undefined;
    }),
    FIXED,
  );
  return { ContextMenu, ContextMenuItem };
}

/** A custom item of a menu a right click shows, and what choosing it calls. */
export interface Avm1MenuItem {
  caption: string;
  enabled: boolean;
  separatorBefore: boolean;
  /** The item, whose onSelect a choice calls. */
  item: avm1.Avm1Object;
}

/** What a right click on `d` shows: the menu of the nearest of it and its parents that has one. */
export interface Avm1Menu {
  /** The object whose `menu` it is, its onSelect's first argument. */
  owner: avm1.Avm1Object;
  menu: avm1.Avm1Object;
  items: Avm1MenuItem[];
  /** Whether its builtInItems keep the quality's. */
  quality: boolean;
}

/**
 * Flash's own entries, which a custom caption may not begin: one that is
 * the start of any, "" among them, is left out of the menu.
 */
const RESERVED = [
  "Zoom In",
  "Zoom Out",
  "100%",
  "Show All",
  "Quality",
  "High",
  "Medium",
  "Low",
  "Play",
  "Loop",
  "Rewind",
  "Forward",
  "Back",
  "Print...",
  "Settings...",
  "About Adobe Flash Player",
  "Show Redraw Regions",
  "Debugger",
];

/**
 * The menu a right click on `d` shows, from `d` up through its parents to
 * the first whose AVM1 object's `menu` is an object, a ContextMenu or not:
 * its onSelect called first with that object and the menu, as Flash
 * Player 32 calls it as the menu opens, through `call`; then its custom
 * items as the projector showed them: each object whose onSelect is a
 * function, a ContextMenuItem or not, but one whose caption begins none of
 * Flash's entries and is no earlier one's, the first 15 of those, the
 * hidden among them, and of those the visible. Null where none has a menu.
 */
export function menuAt(
  d: DisplayObject | null,
  version: number,
  call: (o: avm1.Avm1Object, name: string, args: avm1.Value[]) => void,
): Avm1Menu | null {
  for (let o = d; o !== null; o = o.parent) {
    const owner = o.avm1;
    if (owner === null) {
      continue;
    }

    const menu = avm1.get(owner, "menu", version);
    if (!(menu instanceof avm1.Avm1Object)) {
      continue;
    }

    call(menu, "onSelect", [owner, menu]);
    const result: Avm1Menu = { owner, menu, items: [], quality: true };
    const builtIn = avm1.get(menu, "builtInItems", version);
    if (builtIn instanceof avm1.Avm1Object) {
      result.quality = avm1.toBoolean(avm1.get(builtIn, "quality", version), version);
    }

    const custom = avm1.get(menu, "customItems", version);
    if (!(custom instanceof avm1.Avm1Object)) {
      return result;
    }

    const captions = new Set<string>();
    const length = avm1.toNumber(avm1.get(custom, "length", version), version);
    for (let i = 0; i < length && captions.size < 15; i++) {
      const item = avm1.get(custom, String(i), version);
      if (
        !(item instanceof avm1.Avm1Object) ||
        !(avm1.get(item, "onSelect", version) instanceof avm1.Avm1Function)
      ) {
        continue;
      }

      const caption = avm1.stringOf(avm1.get(item, "caption", version), version);
      if (captions.has(caption) || RESERVED.some((entry) => entry.startsWith(caption))) {
        continue;
      }

      captions.add(caption);
      const flag = (name: string) => avm1.toBoolean(avm1.get(item, name, version), version);
      if (flag("visible")) {
        result.items.push({
          caption,
          enabled: flag("enabled"),
          separatorBefore: flag("separatorBefore"),
          item,
        });
      }
    }

    return result;
  }

  return null;
}
