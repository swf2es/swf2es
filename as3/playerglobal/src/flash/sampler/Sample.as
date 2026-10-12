// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/sampler/Sample.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.sampler
{
	public class Sample
	{
		// Flash Player fills these in, which swf2es does not: their type's default.
		public const time:Number = NaN;
		public const stack:Array = null;
	}
}
