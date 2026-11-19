// The AS3 host of an AVM1 movie with menus of its own: a root whose menu
// hides the built-in items and has one item of its own, and a Loader at
// the origin loading m.swf.
package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.ContextMenuEvent;
	import flash.net.URLRequest;
	import flash.ui.ContextMenu;
	import flash.ui.ContextMenuItem;

	public class LoadedAvm1Menu extends Sprite
	{
		private var ldr:Loader = new Loader();

		public function LoadedAvm1Menu()
		{
			var cm:ContextMenu = new ContextMenu();
			cm.hideBuiltInItems();
			var item:ContextMenuItem = new ContextMenuItem("As3 item");
			item.addEventListener(ContextMenuEvent.MENU_ITEM_SELECT, function(e:ContextMenuEvent):void
				{
					trace("as3:item owner " + e.contextMenuOwner + " target " + e.mouseTarget);
				});
			cm.customItems.push(item);
			cm.addEventListener(ContextMenuEvent.MENU_SELECT, function(e:ContextMenuEvent):void
				{
					trace("as3:menuSelect owner " + e.contextMenuOwner + " target " + e.mouseTarget);
				});
			contextMenu = cm;
			ldr.name = "ldr";
			ldr.load(new URLRequest("m.swf"));
			addChild(ldr);
		}
	}
}
