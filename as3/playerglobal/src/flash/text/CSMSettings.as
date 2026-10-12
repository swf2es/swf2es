// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/text/CSMSettings.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.text
{
	public final class CSMSettings
	{
		public var fontSize:Number;
		public var insideCutoff:Number;
		public var outsideCutoff:Number;

		public function CSMSettings(fontSize:Number, insideCutoff:Number, outsideCutoff:Number)
		{
			this.fontSize = fontSize;
			this.insideCutoff = insideCutoff;
			this.outsideCutoff = outsideCutoff;
		}
	}
}
