// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/NativeMenuItem.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{

	import flash.events.EventDispatcher;

	// According to the documentation, it should be [API("661")]
	// but airglobal.swc disagrees with that:
	public class NativeMenuItem extends EventDispatcher
	{
		private var _enabled:Boolean = false;

		private var _checked:Boolean = false;
		private var _data:Object;
		private var _isSeparator:Boolean;
		private var _keyEquivalent:String = "k";
		private var _keyEquivalentModifiers:Array = [];
		private var _label:String;
		private var _mnemonicIndex:int = 0;
		private var _name:String = "";
		private var _submenu:NativeMenu = new NativeMenu();

		public function NativeMenuItem(label:String = "", isSeparator:Boolean = false)
		{
			this.label = label;
			this._isSeparator = isSeparator;
		}

		public function get enabled():Boolean
		{
			return this._enabled;
		}
		public function set enabled(value:Boolean):void
		{
			this._enabled = value;
		}

		// The rest of the properties are AIR-only

		public function get checked():Boolean
		{
			return this._checked;
		}
		public function set checked(value:Boolean):void
		{
			this._checked = value;
		}

		public function get data():Object
		{
			return this._data;
		}
		public function set data(value:Object):void
		{
			this._data = value;
		}

		public function get isSeparator():Boolean
		{
			return this._isSeparator;
		}

		public function get keyEquivalent():String
		{
			return this._keyEquivalent;
		}
		public function set keyEquivalent(value:String):void
		{
			this._keyEquivalent = value;
		}

		public function get keyEquivalentModifiers():Array
		{
			return this._keyEquivalentModifiers;
		}
		public function set keyEquivalentModifiers(value:Array):void
		{
			this._keyEquivalentModifiers = value;
		}

		public function get label():String
		{
			return this._label;
		}
		public function set label(value:String):void
		{
			this._label = value;
		}

		public function get mnemonicIndex():int
		{
			return this._mnemonicIndex;
		}
		public function set mnemonicIndex(value:int):void
		{
			// TODO validation
			this._mnemonicIndex = value;
		}

		public function get name():String
		{
			return this._name;
		}
		public function set name(value:String):void
		{
			this._name = value;
		}

		public function get submenu():NativeMenu
		{
			return this._submenu;
		}
		public function set submenu(value:NativeMenu):void
		{
			this._submenu = value;
		}

		public function get menu():NativeMenu
		{
			return new NativeMenu();
		}

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		public native function clone():NativeMenuItem;
		override public native function toString():String;
	}
}
