// A menu is a snapshot made after menuSelect, not something polled by the renderer.
import type { avm2 } from "@swf2es/runtime";
import type { As3 } from "../as3/types.js";
import type { Container } from "../display/display.js";
import { dispatchTo } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import { type PointerState, pointerTarget } from "./pointer.js";

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
