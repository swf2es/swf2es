// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/errors/ScriptTimeoutError.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.errors
{
	public dynamic class ScriptTimeoutError extends Error
	{
		ScriptTimeoutError.prototype.name = "ScriptTimeoutError";

		public function ScriptTimeoutError(message:String = "", id:int = 0)
		{
			super(message, id);
		}
	}
}
