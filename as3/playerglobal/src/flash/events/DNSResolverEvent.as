// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("668")]
	public class DNSResolverEvent extends Event
	{
		public function DNSResolverEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:String = "", arg4:Array = null)
		{
			super(arg0);
		}

		public static const LOOKUP:String = "lookup";
		override public native function clone():Event;
		override public native function toString():String;
		public native function get host():String;
		public native function set host(arg0:String):void;
		public native function get resourceRecords():Array;
		public native function set resourceRecords(arg0:Array):void;
	}
}
