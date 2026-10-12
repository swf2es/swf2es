// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/automation/AutomationAction.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.automation
{
	public class AutomationAction
	{
		private var _type:String = "";

		public function get type():String
		{
			return this._type;
		}

		public function set type(value:String):void
		{
			this._type = value;
		}
	}
}
