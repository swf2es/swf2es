// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.system
{
	import flash.events.EventDispatcher;

	[API("682")]
	public final class MessageChannel extends EventDispatcher
	{
		public function MessageChannel()
		{
		}

		public native function send(arg:*, queueLimit:int = -1):void;

		public native function get messageAvailable():Boolean;

		public native function receive(arg0:Boolean = false):*;

		override public native function addEventListener(arg0:String, arg1:Function, arg2:Boolean = false, arg3:int = 0, arg4:Boolean = false):void;

		override public native function removeEventListener(arg0:String, arg1:Function, arg2:Boolean = false):void;

		public native function close():void;

		public native function get state():String;

		override public native function toString():String;
	}
}
