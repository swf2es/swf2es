// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/text/TextLineMetrics.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.text
{
	public class TextLineMetrics
	{
		public var x:Number;
		public var width:Number;
		public var height:Number;
		public var ascent:Number;
		public var descent:Number;
		public var leading:Number;

		public function TextLineMetrics(
				x:Number,
				width:Number,
				height:Number,
				ascent:Number,
				descent:Number,
				leading:Number
			)
		{
			this.x = x;
			this.width = width;
			this.height = height;
			this.ascent = ascent;
			this.descent = descent;
			this.leading = leading;
		}
	}
}
