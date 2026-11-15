// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/NativeMenuItem.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	import flash.errors.IllegalOperationError;
	import flash.events.EventDispatcher;

	// Defaults, checks and toString as AIR's Windows runtime has them.
	public class NativeMenuItem extends EventDispatcher
	{
		// The key codes a key equivalent's modifiers may be; others are dropped.
		private static const MODIFIERS:Array = [14, 15, 16, 17, 18, 20, 21];

		private static const SHIFT:int = 16;

		private static const CONTROL:int = 17;

		// The menu this item is in, and its submenu: NativeMenu keeps both.
		internal var _menu:NativeMenu;

		internal var _submenu:NativeMenu;

		private var _enabled:Boolean = true;

		private var _checked:Boolean = false;

		private var _data:Object;

		private var _isSeparator:Boolean;

		private var _keyEquivalent:String;

		// The modifiers, a bit for each key code: Control's on Windows by default.
		private var _modifiers:uint = 1 << CONTROL;

		private var _label:String = "";

		private var _mnemonicIndex:int = -1;

		private var _name:String;

		public function NativeMenuItem(label:String = "", isSeparator:Boolean = false)
		{
			super();
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

		// A capital adds Shift to the modifiers, which a small letter after does not take away.
		public function set keyEquivalent(value:String):void
		{
			this._keyEquivalent = value;
			if (this.shifted)
			{
				this._modifiers |= 1 << SHIFT;
			}
		}

		// A new array each time, in the order of the key codes.
		public function get keyEquivalentModifiers():Array
		{
			const out:Array = [];
			for (var i:int = 0; i < MODIFIERS.length; i++)
			{
				if (this._modifiers & (1 << MODIFIERS[i]))
				{
					out.push(MODIFIERS[i]);
				}
			}

			return out;
		}

		public function set keyEquivalentModifiers(value:Array):void
		{
			var bits:uint = 0;
			if (value != null)
			{
				for (var i:int = 0; i < value.length; i++)
				{
					const code:int = int(value[i]);
					if (MODIFIERS.indexOf(code) >= 0)
					{
						bits |= 1 << code;
					}
				}
			}

			this._modifiers = this.shifted ? bits | 1 << SHIFT : bits;
		}

		// Whether the key equivalent is a capital, which Shift goes with.
		private function get shifted():Boolean
		{
			if (!this._keyEquivalent)
			{
				return false;
			}

			const first:String = this._keyEquivalent.charAt(0);
			return first != first.toLowerCase();
		}

		public function get label():String
		{
			return this._label;
		}

		public function set label(value:String):void
		{
			this._label = value == null ? "" : value;
		}

		public function get mnemonicIndex():int
		{
			return this._mnemonicIndex;
		}

		// An index into the label as it is, or -1 for none; the label may change after.
		public function set mnemonicIndex(value:int):void
		{
			if (value < -1 || value >= this._label.length)
			{
				throw new RangeError("Error #2006: The supplied index is out of bounds.", 2006);
			}

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

		// Taken from the item in a menu that had it only when this one is in a menu too.
		public function set submenu(value:NativeMenu):void
		{
			this._submenu = value;
			if (this._menu != null && value != null)
			{
				this._menu.adopt(this, value);
			}
		}

		public function get menu():NativeMenu
		{
			return this._menu;
		}

		// All but its data, menu and listeners, with its submenu's clone.
		public function clone():NativeMenuItem
		{
			if (this._isSeparator)
			{
				throw new IllegalOperationError("Error #2037: Functions called in incorrect sequence, or earlier call was unsuccessful.", 2037);
			}

			const copy:NativeMenuItem = new NativeMenuItem(this._label);
			copy._enabled = this._enabled;
			copy._checked = this._checked;
			copy._name = this._name;
			copy._keyEquivalent = this._keyEquivalent;
			copy._modifiers = this._modifiers;
			copy._mnemonicIndex = this._mnemonicIndex;
			if (this._submenu != null)
			{
				copy._submenu = this._submenu.clone();
			}

			return copy;
		}

		// A ContextMenuItem's too, with no caption: as AIR's.
		override public function toString():String
		{
			const key:String = this._keyEquivalent == null ? "null" : "\"" + this._keyEquivalent + "\"";
			const code:int = this._keyEquivalent ? this._keyEquivalent.charCodeAt(0) : 0;
			return "[NativeMenuItem label=\"" + this._label + "\" keyEquivalent=" + key + " keyEquivalentChar=" + code + " keyEquivalentModifiers={ " + this.keyEquivalentModifiers.join(",") + " }]";
		}
	}
}
