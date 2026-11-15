// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/ui/ContextMenuItem.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.ui
{
	import flash.display.NativeMenuItem;

	public class ContextMenuItem extends NativeMenuItem
	{
		private var _separatorBefore:Boolean;

		private var _visible:Boolean;

		public function ContextMenuItem(caption:String, separatorBefore:Boolean = false, enabled:Boolean = true, visible:Boolean = true)
		{
			this.caption = caption;
			this.separatorBefore = separatorBefore;
			this.enabled = enabled;
			this.visible = visible;
		}

		// The item's label, as in AIR.
		public function get caption():String
		{
			return this.label;
		}

		public function set caption(value:String):void
		{
			this.label = value;
		}

		public function get separatorBefore():Boolean
		{
			return this._separatorBefore;
		}

		public function set separatorBefore(value:Boolean):void
		{
			this._separatorBefore = value;
		}

		public function get visible():Boolean
		{
			return this._visible;
		}

		public function set visible(value:Boolean):void
		{
			this._visible = value;
		}

		// As NativeMenuItem's clone: all but its data, menu and listeners.
		override public function clone():NativeMenuItem
		{
			const copy:ContextMenuItem = new ContextMenuItem(this.caption, this.separatorBefore, this.enabled, this.visible);
			copy.checked = this.checked;
			copy.name = this.name;
			copy.keyEquivalent = this.keyEquivalent;
			copy.keyEquivalentModifiers = this.keyEquivalentModifiers;
			copy.mnemonicIndex = this.mnemonicIndex;
			if (this.submenu != null)
			{
				copy.submenu = this.submenu.clone();
			}

			return copy;
		}
	}
}
