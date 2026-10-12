// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/sampler/StackFrame.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.sampler
{
	public final class StackFrame
	{
		// Flash Player fills these in, which swf2es does not: their type's default.
		public const name:String = null;

		public const file:String = null;

		public const line:uint = 0;

		public const scriptID:Number = NaN;

		public function toString():String
		{
			if (this.file)
			{
				return this.name + "()[" + this.file + ":" + this.line + "]";
			}
			else
			{
				return this.name + "()";
			}
		}
	}
}
