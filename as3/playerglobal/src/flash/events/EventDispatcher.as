// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/EventDispatcher.ts.

package flash.events
{
	public class EventDispatcher implements IEventDispatcher
	{
		public function EventDispatcher(target:IEventDispatcher = null)
		{
			ctor(target);
		}

		public native function toString():String;

		public native function addEventListener(type:String, listener:Function, useCapture:Boolean = false, priority:int = 0, useWeakReference:Boolean = false):void;

		public native function removeEventListener(type:String, listener:Function, useCapture:Boolean = false):void;

		public native function dispatchEvent(event:Event):Boolean;

		public native function hasEventListener(type:String):Boolean;

		public native function willTrigger(type:String):Boolean;

		// The player's natives (packages/player/src/playerglobal/flash/events/EventDispatcher.ts).
		private native function ctor(target:IEventDispatcher):void;

		private native function dispatchEventFunction(event:Event):Boolean;
	}
}
