// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/errors/StackOverflowError.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.errors
{
	public dynamic class StackOverflowError extends Error
	{
		StackOverflowError.prototype.name = "StackOverflowError";

		public function StackOverflowError(message:String = "", id:int = 0)
		{
			super(message, id);
		}
	}
}
