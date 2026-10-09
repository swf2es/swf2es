// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/IEventDispatcher.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	public interface IEventDispatcher
	{
		function addEventListener(
				type:String,
				listener:Function,
				useCapture:Boolean = false,
				priority:int = 0,
				useWeakReference:Boolean = false
			):void;

		function dispatchEvent(event:Event):Boolean;

		function hasEventListener(type:String):Boolean;

		function removeEventListener(
				type:String,
				listener:Function,
				useCapture:Boolean = false
			):void;

		function willTrigger(type:String):Boolean;
	}
}
