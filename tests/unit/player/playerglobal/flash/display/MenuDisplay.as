// NativeMenu.display and ContextMenu.display: the events before the menu
// shows, as adl dispatched them, and what a choice dispatches after.
package
{
	import flash.display.NativeMenu;
	import flash.display.NativeMenuItem;
	import flash.display.Sprite;
	import flash.events.ContextMenuEvent;
	import flash.events.Event;
	import flash.ui.ContextMenu;
	import flash.ui.ContextMenuItem;

	public class MenuDisplay extends Sprite
	{
		private const _menu:NativeMenu = new NativeMenu();

		private const _context:ContextMenu = new ContextMenu();

		public function MenuDisplay()
		{
			trace("isSupported " + NativeMenu.isSupported + " builtIn " + _context.builtInItems.zoom);
			const sub:NativeMenu = new NativeMenu();
			const deep:NativeMenuItem = sub.addItem(new NativeMenuItem("deep"));
			const a:NativeMenuItem = _menu.addItem(new NativeMenuItem("a"));
			_menu.addItem(new NativeMenuItem("", true));
			const b:NativeMenuItem = _menu.addItem(new NativeMenuItem("b"));
			b.checked = true;
			const c:NativeMenuItem = _menu.addItem(new NativeMenuItem("c"));
			c.enabled = false;
			const s:NativeMenuItem = _menu.addSubmenu(sub, "S");
			const hidden:ContextMenuItem = new ContextMenuItem("hidden", false, true, false);
			_menu.addItem(hidden);
			const top:NativeMenu = new NativeMenu();
			top.addSubmenu(_menu, "menu");
			listen(top, "top");
			listen(_menu, "menu");
			listen(a, "a");
			listen(b, "b");
			listen(c, "c");
			listen(s, "S");
			listen(deep, "deep");
			listen(hidden, "hidden");
			const shown:ContextMenuItem = new ContextMenuItem("shown", true);
			_context.customItems = [shown, new ContextMenuItem("gone", false, true, false)];
			listen(_context, "context");
			listen(shown, "shown");
		}

		private function listen(target:*, name:String):void
		{
			const types:Array = [Event.PREPARING, Event.DISPLAYING, Event.SELECT, ContextMenuEvent.MENU_ITEM_SELECT];
			for (var i:int = 0; i < types.length; i++)
			{
				target.addEventListener(types[i], function(e:Event):void
				{
					trace(name + " " + e.type + " " + (e.target is NativeMenuItem ? NativeMenuItem(e.target).label : e.target is ContextMenu ? "context" : e.target is NativeMenu ? "a menu" : String(e.target)) + " " + e.eventPhase + " " + e.bubbles);
				});
			}
		}

		public function open():void
		{
			_menu.display(stage, 12, 34);
			trace("returned");
		}

		public function openContext():void
		{
			_context.display(stage, 5, 6);
		}

		public function openNull():void
		{
			try
			{
				_menu.display(null, 0, 0);
			}
			catch (e:Error)
			{
				trace(Object(e).constructor + " " + e.errorID + " " + e.message);
			}
		}
	}
}
