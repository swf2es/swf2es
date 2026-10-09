// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	import flash.media.MediaPromise;

	[API("669")]
	public class MediaEvent extends Event
	{
		public function MediaEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:MediaPromise = null)
		{
			super(arg0);
		}

		public static const COMPLETE:String = "complete";
		public static const SELECT:String = "select";
		public native function get data():MediaPromise;
		override public native function clone():Event;
		override public native function toString():String;
	}
}
