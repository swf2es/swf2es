// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("669")]
	public class LocationChangeEvent extends Event
	{
		public function LocationChangeEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:String = null)
		{
			super(arg0);
		}

		public static const LOCATION_CHANGE:String = "locationChange";
		public static const LOCATION_CHANGING:String = "locationChanging";

		override public native function clone():Event;

		override public native function toString():String;

		public native function get location():String;

		public native function set location(arg0:String):void;
	}
}
