// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/desktop/NativeDragOptions.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.desktop
{
	public class NativeDragOptions
	{
		public var allowCopy:Boolean = true;
		public var allowLink:Boolean = true;
		public var allowMove:Boolean = true;

		public function NativeDragOptions()
		{
		}

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		public native function toString():String;
	}
}
