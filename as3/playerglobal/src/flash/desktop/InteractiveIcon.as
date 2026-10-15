// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/desktop/InteractiveIcon.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.desktop
{

	[API("661")]
	public class InteractiveIcon extends Icon
	{
		public function get height():int
		{
			return 64;
		}

		public function get width():int
		{
			return 64;
		}

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		override public native function get bitmaps():Array;
		override public native function set bitmaps(arg0:Array):void;
	}
}
