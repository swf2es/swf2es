// A menu is a snapshot made after menuSelect, not something polled by the renderer.
import type { avm2 } from "@swf2es/runtime";
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
  const get = (o: avm2.Value, name: string) => rt.getProperty(o, rt.publicName(name));
  const picked = pointerTarget(
    stage,
    p.x,
    p.y,
    s.stageWidth,
    s.stageHeight,
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
  const builtIn = get(menu, "builtInItems");
  result.quality &&= !!builtIn && rt.toBoolean(get(builtIn, "quality"));
  const custom = get(menu, "customItems");
  if (!custom) {
    return result;
  }

  const length = rt.toUint(get(custom, "length"));
  const cls = rt.classNamed("flash.ui::ContextMenuItem");
  const captions = new Set<string>();
  let selected = false;
  for (let i = 0; i < length && result.items.length < 15; i++) {
    const item = get(custom, String(i));
    if (!rt.isInstance(item, cls) || !rt.toBoolean(get(item, "visible"))) {
      continue;
    }

    const caption = rt.toString(get(item, "caption"));
    if (!caption || captions.has(caption)) {
      continue;
    }

    captions.add(caption);
    const enabled = rt.toBoolean(get(item, "enabled"));
    result.items.push({
      caption,
      enabled,
      separatorBefore: rt.toBoolean(get(item, "separatorBefore")),
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
