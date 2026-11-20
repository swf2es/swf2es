// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.events
{
	[API("688")]
	public class AVStreamSwitchEvent extends Event
	{
		public static const AV_STREAM_SWITCH:String = "avStreamSwitch";
		public static const ABR_SWITCH:int = 0;
		public static const PERIOD_SWITCH:int = 1;

		private var _time:Number;
		private var _switchType:int;
		private var _bitrate:int;
		private var _description:String;
		private var _userData:int;

		public function AVStreamSwitchEvent(type:String = "avStreamSwitch", bubbles:Boolean = false, cancelable:Boolean = false, time:Number = 0, switchType:int = 0, bitrate:int = 0, description:String = "", userData:int = 0)
		{
			super(type, bubbles, cancelable);
			_time = time;
			_switchType = switchType;
			_bitrate = bitrate;
			_description = description;
			_userData = userData;
		}

		public function get time():Number
		{
			return _time;
		}

		public function get switchType():int
		{
			return _switchType;
		}

		public function get bitrate():int
		{
			return _bitrate;
		}

		public function get description():String
		{
			return _description;
		}

		public function get userData():int
		{
			return _userData;
		}
	}
}
