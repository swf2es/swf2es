// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/ui/ContextMenu.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.ui
{
	import flash.display.NativeMenuItem;
	import flash.display.Stage;
	import flash.net.URLRequest;

	import flash.display.NativeMenu;

	public class ContextMenu extends NativeMenu
	{
		private var _customItems:Array;

		private var _clipboardMenu:Boolean;

		private var _builtInItems:ContextMenuBuiltInItems = new ContextMenuBuiltInItems();

		private var _clipboardItems:ContextMenuClipboardItems = new ContextMenuClipboardItems();

		public function ContextMenu()
		{
			super();
			this.customItems = new Array();
		}

		public function get customItems():Array
		{
			return this._customItems;
		}

		public function set customItems(value:Array):void
		{
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

		public function set builtInItems(value:ContextMenuBuiltInItems):void
		{
			this._builtInItems = value;
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

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		override public native function get numItems():int;
		override public native function get items():Array;
		override public native function set items(arg0:Array):void;
		override public native function addItemAt(arg0:NativeMenuItem, arg1:int):NativeMenuItem;
		override public native function containsItem(arg0:NativeMenuItem):Boolean;
		override public native function getItemAt(arg0:int):NativeMenuItem;
		override public native function removeItemAt(arg0:int):NativeMenuItem;
		override public native function getItemIndex(arg0:NativeMenuItem):int;
		override public native function removeAllItems():void;
		public native function get link():URLRequest;
		public native function set link(arg0:URLRequest):void;
		override public native function display(arg0:Stage, arg1:Number, arg2:Number):void;
		override public native function clone():NativeMenu;
	}
}
