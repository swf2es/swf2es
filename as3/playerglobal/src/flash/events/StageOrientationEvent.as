// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("668")]
	public class StageOrientationEvent extends Event
	{
		public function StageOrientationEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:String = null, arg4:String = null)
		{
			super(arg0);
		}

		public static const ORIENTATION_CHANGING:String = "orientationChanging";
		public static const ORIENTATION_CHANGE:String = "orientationChange";
		override public native function clone():Event;
		public native function get beforeOrientation():String;
		public native function get afterOrientation():String;
		override public native function toString():String;
	}
}
