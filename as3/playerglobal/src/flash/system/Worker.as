// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/system/Worker.ts.

package flash.system
{
	import flash.events.EventDispatcher;

	[API("682")]
	public final class Worker extends EventDispatcher
	{
		// The primordial worker, which the player's class hook sets (Worker.ts).
		private static var _current:Worker;

		public function Worker()
		{
		}

		public static native function get isSupported():Boolean;

		public static function get current():Worker
		{
			return _current;
		}

		public native function createMessageChannel(receiver:Worker):MessageChannel;

		public native function start():void;

		public native function setSharedProperty(key:String, value:*):void;

		public native function getSharedProperty(key:String):*;

		public native function get isPrimordial():Boolean;

		public function get state():String
		{
			return internalGetState();
		}

		override public function addEventListener(type:String, listener:Function, useCapture:Boolean = false, priority:int = 0, useWeakReference:Boolean = false):void
		{
			super.addEventListener(type, listener, useCapture, priority, useWeakReference);
			internalAddEventListener(type, listener, useCapture, priority, useWeakReference);
		}

		override public function removeEventListener(type:String, listener:Function, useCapture:Boolean = false):void
		{
			super.removeEventListener(type, listener, useCapture);
			internalRemoveEventListener(type, listener, useCapture);
		}

		public native function terminate():Boolean;

		// The player's natives (packages/player/src/playerglobal/flash/system/Worker.ts).
		private native function internalSetSharedProperty(key:String, value:*):void;

		private native function internalGetSharedProperty(key:String):*;

		private native function internalGetState():String;

		private native function internalAddEventListener(arg0:String, arg1:Function, arg2:Boolean, arg3:int, arg4:Boolean):void;

		private native function internalRemoveEventListener(arg0:String, arg1:Function, arg2:Boolean):void;
	}
}
