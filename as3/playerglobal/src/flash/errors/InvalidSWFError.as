// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/errors/InvalidSWFError.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.errors
{
	public dynamic class InvalidSWFError extends Error
	{
		prototype.name = "InvalidSWFError";

		public function InvalidSWFError(message:String = "", id:int = 0)
		{
			super(message, id);
		}
	}
}
