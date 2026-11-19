// A menu is a snapshot made after menuSelect, not something polled by the renderer.
import type { avm2 } from "@swf2es/runtime";
import type { As3 } from "../as3/types.js";
import type { Container } from "../display/display.js";
import { dispatchAlong, dispatchTo } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import { pointerTarget } from "./hit-test.js";
import type { PointerState } from "./pointer.js";

export interface MenuItem {
  caption: string;
  enabled: boolean;
  separatorBefore?: boolean;
  checked?: boolean;
  select(): void;
}

export interface ContextMenu {
  items: MenuItem[];
  quality: boolean;
}

export function customContextMenu(s: Scripting, stage: Container, p: PointerState): ContextMenu {
  const result: ContextMenu = { items: [], quality: s.showDefaultContextMenu };
  s.mouseStageX = p.x;
  s.mouseStageY = p.y;
  const rt = s.rt;
  // An element of the custom items, by index, which no class declares.
  const at = (o: avm2.Value, i: number) => rt.getProperty(o, rt.publicName(String(i)));
  const picked = pointerTarget(
    stage,
    p.x,
    p.y,
    s.stageViewportWidth || s.stageWidth,
    s.stageViewportHeight || s.stageHeight,
    undefined,
    s.stageViewportX,
    s.stageViewportY,
  );
  // Over a loaded AVM1 movie, the movie's menu where one of its clips has one, as Flash Player 32 shows it.
  const hosted = s.avm1Input?.menu(p, picked) ?? null;
  if (hosted !== null) {
    return { items: hosted.items, quality: result.quality && hosted.quality };
  }

  const target = picked === stage ? s.root : picked;
  let owner = target;
  let menu: avm2.AsObject | null = null;
  for (; owner; owner = owner.parent) {
    const value = owner.object?.$contextMenu;
    if (value && rt.isInstance(value, rt.classNamed("flash.ui::ContextMenu"))) {
      menu = value;
      break;
    }
  }

  if (!menu) {
    return result;
  }

  const mouse = target?.object ?? null;
  const contextOwner = owner?.object ?? null;
  const event = (type: string) =>
    rt.construct(
      rt.classNamed("flash.events::ContextMenuEvent"),
      type,
      false,
      false,
      mouse,
      contextOwner,
    );
  dispatchTo(s, menu, event("menuSelect"));
  const contextMenu = menu as As3<"flash.ui::ContextMenu">;
  const builtIn = rt.prop(contextMenu, "builtInItems");
  result.quality &&= !!builtIn && rt.toBoolean(rt.prop(builtIn, "quality"));
  const custom = rt.prop(contextMenu, "customItems");
  if (!custom) {
    return result;
  }

  const length = rt.toUint(rt.prop(custom, "length"));
  const cls = rt.classNamed("flash.ui::ContextMenuItem");
  const captions = new Set<string>();
  let selected = false;
  for (let i = 0; i < length && result.items.length < 15; i++) {
    const element = at(custom, i);
    if (!rt.isInstance(element, cls)) {
      continue;
    }

    const item = element as As3<"flash.ui::ContextMenuItem">;
    if (!rt.toBoolean(rt.prop(item, "visible"))) {
      continue;
    }

    const caption = rt.toString(rt.prop(item, "caption"));
    if (!caption || captions.has(caption)) {
      continue;
    }

    captions.add(caption);
    const enabled = rt.toBoolean(rt.prop(item, "enabled"));
    result.items.push({
      caption,
      enabled,
      separatorBefore: rt.toBoolean(rt.prop(item, "separatorBefore")),
      select: () => {
        if (!enabled || selected || s.destroyed) {
          return;
        }

        selected = true;
        s.clipboard.gesture(() => dispatchTo(s, item, event("menuItemSelect")));
        s.updates++;
      },
    });
  }

  return result;
}

/**
 * NativeMenu.display's menu of `shown`, the items of `menu` it shows: a
 * separator item draws a line before the next, and a submenu's item is
 * there but cannot be opened yet. A choice is AIR's: a ContextMenuItem's
 * menuItemSelect, any other item's select, from the item up through `menu`
 * and the menus above it.
 */
export function nativeMenuItems(s: Scripting, menu: avm2.AsObject, shown: avm2.Value): MenuItem[] {
  const rt = s.rt;
  const at = (o: avm2.Value, i: number) => rt.getProperty(o, rt.publicName(String(i)));
  const length = rt.toUint(rt.prop(shown as As3<"Array">, "length"));
  const contextItem = rt.classNamed("flash.ui::ContextMenuItem");
  const items: MenuItem[] = [];
  let separator = false;
  let selected = false;
  for (let i = 0; i < length; i++) {
    const item = at(shown, i) as As3<"flash.display::NativeMenuItem">;
    if (rt.prop(item, "isSeparator")) {
      separator = items.length > 0;
      continue;
    }

    const isContext = rt.isInstance(item, contextItem);
    const submenu = rt.prop(item, "submenu");
    const enabled = !submenu && rt.prop(item, "enabled");
    const before =
      isContext && rt.prop(item as As3<"flash.ui::ContextMenuItem">, "separatorBefore");
    items.push({
      caption: `${rt.prop(item, "label") ?? ""}${submenu ? " \u25b8" : ""}`,
      enabled,
      separatorBefore: separator || before,
      checked: rt.prop(item, "checked") || undefined,
      select: () => {
        if (!enabled || selected || s.destroyed) {
          return;
        }

        selected = true;
        s.clipboard.gesture(() => {
          if (isContext) {
            const event = rt.construct(
              rt.classNamed("flash.events::ContextMenuEvent"),
              "menuItemSelect",
              false,
              false,
              null,
              null,
            );
            dispatchTo(s, item, event);
            return;
          }

          // Up through the menus, each once: a submenu set later may have closed a loop.
          const path: (readonly [avm2.AsObject, avm2.AsObject])[] = [[item, item]];
          const seen = new Set<avm2.AsObject>();
          for (
            let m: avm2.AsObject | null = menu;
            m && !seen.has(m);
            m = rt.prop(m as As3<"flash.display::NativeMenu">, "parent")
          ) {
            seen.add(m);
            path.push([m, m]);
          }

          const event = rt.construct(rt.classNamed("flash.events::Event"), "select", true, false);
          dispatchAlong(s, event, path);
        });
        s.updates++;
      },
    });
    separator = false;
  }

  return items;
}
