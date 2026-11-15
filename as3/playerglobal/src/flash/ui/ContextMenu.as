// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/ui/ContextMenu.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.ui
{
	import flash.display.NativeMenu;
	import flash.display.NativeMenuItem;
	import flash.display.Stage;
	import flash.net.URLRequest;

	// The items are customItems, the array itself, as in AIR: what is pushed
	// onto it is an item at once. Setting it puts its items in this menu as
	// NativeMenu does, which is what an item's menu reads; the other ways in
	// and out leave that as it was.
	public class ContextMenu extends NativeMenu
	{
		private var _customItems:Array = [];

		private var _clipboardMenu:Boolean;

		private var _builtInItems:ContextMenuBuiltInItems = new ContextMenuBuiltInItems();

		private var _clipboardItems:ContextMenuClipboardItems = new ContextMenuClipboardItems();

		public function ContextMenu()
		{
			super();
			// AIR's menus have none of Flash Player's own items.
			if (NativeMenu.isSupported)
			{
				this.hideBuiltInItems();
			}
		}

		public function get customItems():Array
		{
			return this._customItems;
		}

		// The old items out of this menu and the new in, each checked as
		// NativeMenu.addItem checks it; one refused leaves the array as it was.
		public function set customItems(value:Array):void
		{
			if (value == null)
			{
				throw new ArgumentError("Error #2005: Parameter value is of the incorrect type. Should be type .", 2005);
			}

			super.removeAllItems();
			for (var i:int = 0; i < value.length; i++)
			{
				super.addItemAt(value[i], super.numItems);
			}

			this._customItems = value;
		}

		public function hideBuiltInItems():void
		{
			if (this._builtInItems)
			{
				this._builtInItems.forwardAndBack = false;
				this._builtInItems.loop = false;
				this._builtInItems.play = false;
				this._builtInItems.print = false;
				this._builtInItems.quality = false;
				this._builtInItems.rewind = false;
				this._builtInItems.save = false;
				this._builtInItems.zoom = false;
			}
		}

		public function get builtInItems():ContextMenuBuiltInItems
		{
			return this._builtInItems;
		}

		// In AIR, the items given are turned off too; one set after stays set.
		public function set builtInItems(value:ContextMenuBuiltInItems):void
		{
			this._builtInItems = value;
			if (NativeMenu.isSupported)
			{
				this.hideBuiltInItems();
			}
		}

		public function get clipboardItems():ContextMenuClipboardItems
		{
			return this._clipboardItems;
		}

		public function set clipboardItems(value:ContextMenuClipboardItems):void
		{
			this._clipboardItems = value;
		}

		public function get clipboardMenu():Boolean
		{
			return this._clipboardMenu;
		}

		public function set clipboardMenu(value:Boolean):void
		{
			this._clipboardMenu = value;
		}

		[API("667")]
		public static function get isSupported():Boolean
		{
			return true;
		}

		override public function get numItems():int
		{
			return this._customItems.length;
		}

		override public function get items():Array
		{
			return this._customItems;
		}

		override public function set items(value:Array):void
		{
			this.customItems = value;
		}

		// No item of another menu, as NativeMenu's, but the item's menu is left as it was.
		override public function addItemAt(item:NativeMenuItem, index:int):NativeMenuItem
		{
			if (index < 0 || index > this._customItems.length)
			{
				throw new RangeError("Error #2006: The supplied index is out of bounds.", 2006);
			}

			if (item == null)
			{
				throw new ArgumentError("Error #2007: Parameter item must be non-null.", 2007);
			}

			if (item.menu != null)
			{
				throw new ArgumentError("Error #2004: One of the parameters is invalid.", 2004);
			}

			this._customItems.splice(index, 0, item);
			return item;
		}

		override public function containsItem(item:NativeMenuItem):Boolean
		{
			return this.indexOf(item) >= 0;
		}

		override public function getItemAt(index:int):NativeMenuItem
		{
			if (index < 0 || index >= this._customItems.length)
			{
				throw new RangeError("Error #2006: The supplied index is out of bounds.", 2006);
			}

			return this._customItems[index];
		}

		override public function removeItemAt(index:int):NativeMenuItem
		{
			if (index < 0 || index >= this._customItems.length)
			{
				throw new RangeError("Error #2006: The supplied index is out of bounds.", 2006);
			}

			return this._customItems.splice(index, 1)[0];
		}

		override public function getItemIndex(item:NativeMenuItem):int
		{
			return this.indexOf(item);
		}

		override public function removeAllItems():void
		{
			this._customItems.length = 0;
		}

		public native function get link():URLRequest;

		public native function set link(arg0:URLRequest):void;

		override public function display(stage:Stage, stageX:Number, stageY:Number):void
		{
			super.display(stage, stageX, stageY);
		}

		// The items' clones, in no menu, the clipboard's choices and the link;
		// the built-in items as a new menu has them.
		override public function clone():NativeMenu
		{
			const copy:ContextMenu = new ContextMenu();
			for (var i:int = 0; i < this._customItems.length; i++)
			{
				const item:NativeMenuItem = this._customItems[i];
				copy._customItems.push(item.clone());
			}

			copy._clipboardMenu = this._clipboardMenu;
			copy._clipboardItems = this._clipboardItems == null ? null : this._clipboardItems.clone();
			copy.link = this.link;
			return copy;
		}

		private function indexOf(item:NativeMenuItem):int
		{
			if (item == null)
			{
				throw new ArgumentError("Error #2007: Parameter item must be non-null.", 2007);
			}

			return this._customItems.indexOf(item);
		}
	}
}
