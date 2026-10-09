// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/desktop/Icon.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.desktop
{
	import flash.events.EventDispatcher;

	[API("661")]
	public class Icon extends EventDispatcher
	{
		private var _bitmaps:Array;

		public function get bitmaps():Array
		{
			return this._bitmaps;
		}

		public function set bitmaps(value:Array):void
		{
			this._bitmaps = value;
		}

		function Icon()
		{
		}
	}
}
