// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/sampler/StackFrame.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.sampler
{
	public final class StackFrame
	{
		public const name:String;

		public const file:String;

		public const line:uint;

		public const scriptID:Number;

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
