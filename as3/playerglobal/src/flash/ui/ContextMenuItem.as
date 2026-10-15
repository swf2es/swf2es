// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/ui/ContextMenuItem.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.ui
{
	import flash.display.NativeMenuItem;

	public class ContextMenuItem extends NativeMenuItem
	{
		public function ContextMenuItem(
				caption:String,
				separatorBefore:Boolean = false,
				enabled:Boolean = true,
				visible:Boolean = true
			)
		{
			this.caption = caption;
			this.separatorBefore = separatorBefore;
			this.enabled = enabled;
			this.visible = visible;
		}

		public function get caption():String
		{
			return this._caption;
		}
		public function set caption(value:String):void
		{
			this._caption = value;
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

		override public function clone():NativeMenuItem
		{
			return new ContextMenuItem(this.caption, this.separatorBefore, this.enabled, this.visible);
		}

		private var _caption:String;

		private var _separatorBefore:Boolean;

		private var _visible:Boolean;
	}
}
