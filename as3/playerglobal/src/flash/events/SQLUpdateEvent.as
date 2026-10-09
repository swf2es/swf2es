// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("661")]
	public class SQLUpdateEvent extends Event
	{
		public function SQLUpdateEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:String = null, arg4:Number = 0)
		{
			super(arg0);
		}

		public static const UPDATE:String = "update";
		public static const INSERT:String = "insert";
		public static const DELETE:String = "delete";
		public native function get table():String;
		public native function get rowID():Number;
		override public native function clone():Event;
	}
}
