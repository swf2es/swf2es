// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/text/ime/CompositionAttributeRange.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.text.ime
{
	[API("667")]
	public final class CompositionAttributeRange
	{
		public var converted:Boolean;
		public var relativeStart:int;
		public var relativeEnd:int;
		public var selected:Boolean;

		public function CompositionAttributeRange(
				relativeStart:int,
				relativeEnd:int,
				selected:Boolean,
				converted:Boolean
			)
		{
			this.relativeStart = relativeStart;
			this.relativeEnd = relativeEnd;
			this.selected = selected;
			this.converted = converted;
		}
	}
}
