// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/system/Worker.ts.

package flash.system
{
	import flash.events.EventDispatcher;

	[API("682")]
	public final class Worker extends EventDispatcher
	{
		public function Worker()
		{
		}

		public static native function get isSupported():Boolean;
		public static native function get current():Worker;
		public native function createMessageChannel(receiver:Worker):MessageChannel;
		public native function start():void;
		public native function setSharedProperty(key:String, value:*):void;
		public native function getSharedProperty(key:String):*;
		public native function get isPrimordial():Boolean;
		public native function get state():String;
		override public native function addEventListener(arg0:String, arg1:Function, arg2:Boolean = false, arg3:int = 0, arg4:Boolean = false):void;
		override public native function removeEventListener(arg0:String, arg1:Function, arg2:Boolean = false):void;
		public native function terminate():Boolean;
	}
}
