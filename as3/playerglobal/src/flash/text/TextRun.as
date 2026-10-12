// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/text/TextRun.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.text
{
	public class TextRun
	{
		public var beginIndex:int;
		public var endIndex:int;
		public var textFormat:TextFormat;

		public function TextRun(beginIndex:int, endIndex:int, textFormat:TextFormat)
		{
			this.beginIndex = beginIndex;
			this.endIndex = endIndex;
			this.textFormat = textFormat;
		}
	}
}
