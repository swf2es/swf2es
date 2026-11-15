// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/NativeMenu.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	import flash.events.ContextMenuEvent;
	import flash.events.Event;
	import flash.events.EventDispatcher;
	import flash.events.MouseEvent;
	import flash.ui.ContextMenuItem;

	// A menu's items as AIR keeps them: an item is in one menu at a time, and a
	// submenu's parent is the menu of the item in a menu that last took it.
	// Methods AIR builds on others call them as overridden, as ContextMenu's.
	public class NativeMenu extends EventDispatcher
	{
		private var _items:Array = [];

		private var _parent:NativeMenu;

		// The item in a menu whose submenu this is, which an item put in a menu later takes it from.
		internal var _holder:NativeMenuItem;

		public function NativeMenu()
		{
			super();
		}

		// AIR's desktop menus, which display shows as the player's own menu.
		public static native function get isSupported():Boolean;

		public function get parent():NativeMenu
		{
			return this._parent;
		}

		public function get numItems():int
		{
			return this._items.length;
		}

		public function get items():Array
		{
			return this._items.concat();
		}

		public function set items(value:Array):void
		{
			this.removeAllItems();
			for (var i:int = 0; i < value.length; i++)
			{
				this.addItemAt(value[i], this._items.length);
			}
		}

		public function addItem(item:NativeMenuItem):NativeMenuItem
		{
			return this.addItemAt(item, this.numItems);
		}

		// An item whose submenu is this menu or one above it is left out: null.
		public function addItemAt(item:NativeMenuItem, index:int):NativeMenuItem
		{
			if (index < 0 || index > this._items.length)
			{
				throw new RangeError("Error #2006: The supplied index is out of bounds.", 2006);
			}

			if (item == null)
			{
				throw new ArgumentError("Error #2007: Parameter item must be non-null.", 2007);
			}

			if (item._menu != null)
			{
				throw new ArgumentError("Error #2004: One of the parameters is invalid.", 2004);
			}

			const submenu:NativeMenu = item._submenu;
			if (submenu != null && this.isWithin(submenu))
			{
				return null;
			}

			this._items.splice(index, 0, item);
			item._menu = this;
			if (submenu != null)
			{
				this.adopt(item, submenu);
			}

			return item;
		}

		public function addSubmenu(submenu:NativeMenu, label:String):NativeMenuItem
		{
			return this.addSubmenuAt(submenu, this.numItems, label);
		}

		public function addSubmenuAt(submenu:NativeMenu, index:int, label:String):NativeMenuItem
		{
			const item:NativeMenuItem = new NativeMenuItem(label);
			item.submenu = submenu;
			return this.addItemAt(item, index);
		}

		// Deep: each item's clone, with its submenu's; a separator's refuses.
		public function clone():NativeMenu
		{
			const copy:NativeMenu = new NativeMenu();
			for (var i:int = 0; i < this._items.length; i++)
			{
				copy.addItem(NativeMenuItem(this._items[i]).clone());
			}

			return copy;
		}

		public function containsItem(item:NativeMenuItem):Boolean
		{
			return this.indexOf(item) >= 0;
		}

		// AIR's preparing and displaying, to the menu and then to each item it
		// shows; then the player's menu, where the host has one. AIR's waits
		// for a choice; this one returns, and the choice comes later.
		public function display(stage:Stage, stageX:Number, stageY:Number):void
		{
			if (stage == null)
			{
				throw new TypeError("Error #2007: Parameter stage must be non-null.", 2007);
			}

			const shown:Array = [];
			const count:int = this.numItems;
			for (var i:int = 0; i < count; i++)
			{
				const item:NativeMenuItem = this.getItemAt(i);
				if (item != null && !(item is ContextMenuItem && !ContextMenuItem(item).visible))
				{
					shown.push(item);
				}
			}

			this.dispatchEvent(new Event(Event.PREPARING));
			for (i = 0; i < shown.length; i++)
			{
				shown[i].dispatchEvent(new Event(Event.PREPARING));
			}

			this.dispatchEvent(new Event(Event.DISPLAYING));
			for (i = 0; i < shown.length; i++)
			{
				shown[i].dispatchEvent(new Event(Event.DISPLAYING));
			}

			this.show(shown, stageX, stageY);
		}

		public function getItemAt(index:int):NativeMenuItem
		{
			if (index < 0 || index >= this._items.length)
			{
				throw new RangeError("Error #2006: The supplied index is out of bounds.", 2006);
			}

			return this._items[index];
		}

		public function getItemByName(name:String):NativeMenuItem
		{
			if (name == null)
			{
				throw new ArgumentError("Error #2007: Parameter name must be non-null.", 2007);
			}

			const count:int = this.numItems;
			for (var i:int = 0; i < count; i++)
			{
				const item:NativeMenuItem = this.getItemAt(i);
				if (item != null && item.name == name)
				{
					return item;
				}
			}

			return null;
		}

		public function getItemIndex(item:NativeMenuItem):int
		{
			return this.indexOf(item);
		}

		public function removeAllItems():void
		{
			for (var i:int = 0; i < this._items.length; i++)
			{
				this.release(this._items[i]);
			}

			this._items = [];
		}

		public function removeItem(item:NativeMenuItem):NativeMenuItem
		{
			const index:int = this.getItemIndex(item);
			if (index < 0)
			{
				throw new RangeError("Error #2006: The supplied index is out of bounds.", 2006);
			}

			return this.removeItemAt(index);
		}

		public function removeItemAt(index:int):NativeMenuItem
		{
			if (index < 0 || index >= this._items.length)
			{
				throw new RangeError("Error #2006: The supplied index is out of bounds.", 2006);
			}

			const item:NativeMenuItem = this._items.splice(index, 1)[0];
			this.release(item);
			return item;
		}

		// An item taken out and put back at an index of the items as they
		// were; one this menu lacks is put in, as addItemAt would.
		public function setItemIndex(item:NativeMenuItem, index:int):void
		{
			const from:int = this.getItemIndex(item);
			if (index < 0 || index >= this.numItems)
			{
				throw new RangeError("Error #2006: The supplied index is out of bounds.", 2006);
			}

			if (from >= 0)
			{
				this.removeItemAt(from);
			}

			this.addItemAt(item, index);
		}

		public function dispatchContextMenuSelect(event:MouseEvent):*
		{
			const target:InteractiveObject = event != null ? event.target as InteractiveObject : null;
			const owner:InteractiveObject = event != null ? event.currentTarget as InteractiveObject : null;
			this.dispatchEvent(new ContextMenuEvent(ContextMenuEvent.MENU_SELECT, false, false, target, owner));
		}

		// `submenu` becomes the submenu of `item`, in this menu: the item in a menu that had it loses it.
		internal function adopt(item:NativeMenuItem, submenu:NativeMenu):void
		{
			const holder:NativeMenuItem = submenu._holder;
			if (holder != null && holder != item && holder._menu != null && holder._submenu == submenu)
			{
				holder._submenu = null;
			}

			submenu._holder = item;
			submenu._parent = this;
		}

		private function release(item:NativeMenuItem):void
		{
			item._menu = null;
			const submenu:NativeMenu = item._submenu;
			if (submenu != null && submenu._holder == item)
			{
				submenu._holder = null;
				submenu._parent = null;
			}
		}

		private function indexOf(item:NativeMenuItem):int
		{
			if (item == null)
			{
				throw new ArgumentError("Error #2007: Parameter item must be non-null.", 2007);
			}

			return this._items.indexOf(item);
		}

		// Whether `menu` is this one or one above it. A submenu set on an item
		// already in a menu is not checked, as in AIR, and may close a loop:
		// the walk stops.
		private function isWithin(menu:NativeMenu):Boolean
		{
			var m:NativeMenu = this;
			for (var depth:int = 0; m != null && depth < 10000; depth++)
			{
				if (m == menu)
				{
					return true;
				}

				m = m._parent;
			}

			return false;
		}

		// The player's menu of `shown`, the items as display found them, at a point on the stage.
		private native function show(shown:Array, stageX:Number, stageY:Number):void;
	}
}
