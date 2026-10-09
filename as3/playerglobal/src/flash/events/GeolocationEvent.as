// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("668")]
	public class GeolocationEvent extends Event
	{
		public function GeolocationEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:Number = 0, arg4:Number = 0, arg5:Number = 0, arg6:Number = 0, arg7:Number = 0, arg8:Number = 0, arg9:Number = 0, arg10:Number = 0)
		{
			super(arg0);
		}

		public static const UPDATE:String = "update";
		override public native function clone():Event;
		override public native function toString():String;
		public native function get latitude():Number;
		public native function set latitude(arg0:Number):void;
		public native function get longitude():Number;
		public native function set longitude(arg0:Number):void;
		public native function get altitude():Number;
		public native function set altitude(arg0:Number):void;
		public native function get horizontalAccuracy():Number;
		public native function set horizontalAccuracy(arg0:Number):void;
		public native function get verticalAccuracy():Number;
		public native function set verticalAccuracy(arg0:Number):void;
		public native function get speed():Number;
		public native function set speed(arg0:Number):void;
		public native function get heading():Number;
		public native function set heading(arg0:Number):void;
		public native function get timestamp():Number;
		public native function set timestamp(arg0:Number):void;
	}
}
