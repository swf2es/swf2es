package {
  import flash.display.Sprite;
  import flash.events.ContextMenuEvent;
  import flash.events.MouseEvent;
  import flash.external.ExternalInterface;
  import flash.ui.ContextMenu;
  import flash.ui.ContextMenuItem;

  public class ContextMenuTest extends Sprite {
    private var owner:Sprite = new Sprite();
    private var child:Sprite = new Sprite();
    private var menu:ContextMenu = new ContextMenu();
    private var item:ContextMenuItem = new ContextMenuItem("Action");
    private var count:int = 0;

    public function ContextMenuTest() {
      graphics.beginFill(0xffffff);
      graphics.drawRect(0, 0, 200, 120);
      owner.name = "owner";
      owner.x = owner.y = 20;
      owner.graphics.beginFill(0x00aa00);
      owner.graphics.drawRect(0, 0, 100, 80);
      addChild(owner);
      child.name = "child";
      child.x = child.y = 10;
      child.graphics.beginFill(0x0000aa);
      child.graphics.drawRect(0, 0, 40, 40);
      owner.addChild(child);
      menu.hideBuiltInItems();
      menu.customItems = [item, new ContextMenuItem("Disabled", false, false),
        new ContextMenuItem("Hidden", false, true, false),
        new ContextMenuItem("<b>Literal</b>", true)];
      owner.contextMenu = menu;
      menu.addEventListener(ContextMenuEvent.MENU_SELECT, opening);
      item.addEventListener(ContextMenuEvent.MENU_ITEM_SELECT, selected);
      addEventListener(MouseEvent.CONTEXT_MENU, context);
      var rootMenu:ContextMenu = new ContextMenu();
      rootMenu.hideBuiltInItems();
      rootMenu.customItems = [new ContextMenuItem("Root action")];
      rootMenu.addEventListener(ContextMenuEvent.MENU_SELECT, opening);
      contextMenu = rootMenu;
      ExternalInterface.addCallback("menuMode", menuMode);
      ExternalInterface.addCallback("menuState", function():Object {
        return {count:count, caption:item.caption, fixed:stage.showDefaultContextMenu};
      });
    }

    private function report(e:ContextMenuEvent):void {
      trace(e.type, e.mouseTarget ? e.mouseTarget.name : null,
        e.contextMenuOwner ? e.contextMenuOwner.name : null,
        e.bubbles, e.cancelable, e.eventPhase);
      ExternalInterface.call("menuTrace", [e.type,
        e.target === menu ? "menu" : e.target === item ? "item" : "rootMenu",
        e.mouseTarget ? e.mouseTarget.name : null,
        e.contextMenuOwner ? e.contextMenuOwner.name : null,
        e.bubbles, e.cancelable, e.eventPhase]);
    }

    private function opening(e:ContextMenuEvent):void {
      report(e);
      item.caption = "Action " + (++count);
    }

    private function selected(e:ContextMenuEvent):void {
      report(e);
    }

    private function context(e:MouseEvent):void {
      ExternalInterface.call("menuTrace", [e.type, e.target.name,
        e.bubbles, e.cancelable, e.eventPhase]);
    }

    public function menuMode(value:String):void {
      switch (value) {
        case "own":
          child.contextMenu = menu;
          break;
        case "inherit":
          child.contextMenu = null;
          break;
        case "hidden":
          item.visible = false;
          break;
        case "visible":
          item.visible = true;
          break;
        case "defaults":
          contextMenu = null;
          owner.contextMenu = null;
          child.contextMenu = null;
          break;
        case "noDefaults":
          stage.showDefaultContextMenu = false;
          break;
        case "throw":
          menu.addEventListener(ContextMenuEvent.MENU_SELECT, function(e:ContextMenuEvent):void {
            throw new Error("menu handler");
          });
          break;
      }
    }
  }
}
