// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/printing/PrintJobOptions.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.printing
{
	public class PrintJobOptions
	{
		public var printAsBitmap:Boolean = false;

		public function PrintJobOptions(printAsBitmap:Boolean = false)
		{
			this.printAsBitmap = printAsBitmap;
		}

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		[API("668")]
		public native function set printMethod(arg0:String):void;
		[API("668")]
		public native function get printMethod():String;
		[API("668")]
		public var pixelsPerInch:Number = NaN;
	}
}
