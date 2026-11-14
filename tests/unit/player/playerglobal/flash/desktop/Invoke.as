package
{
	import flash.desktop.NativeApplication;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.InvokeEvent;

	public class Invoke extends Sprite
	{
		public function Invoke()
		{
			var app:NativeApplication = NativeApplication.nativeApplication;
			trace("ctor: adding");
			app.addEventListener(InvokeEvent.INVOKE, function(i:InvokeEvent):void
				{
					trace("invoke A", i.target == app, i.currentTarget == app, i.eventPhase, i.bubbles, i.cancelable, i.arguments.join("|"), i.reason);
				});
			trace("ctor: added");
			app.addEventListener(InvokeEvent.INVOKE, function(i:InvokeEvent):void
				{
					trace("invoke B");
				});
			trace("ctor: added B");
			var frames:int = 0;
			addEventListener(Event.ENTER_FRAME, function(e:Event):void
				{
					frames++;
					trace("frame", frames);
					if (frames == 2)
					{
						trace("frame 2: adding C");
						app.addEventListener(InvokeEvent.INVOKE, function(i:InvokeEvent):void
							{
								trace("invoke C");
							});
						trace("frame 2: added C");
						app.dispatchEvent(new InvokeEvent(InvokeEvent.INVOKE, false, false, null, ["manual"]));
						trace("frame 2: dispatched manual");
					}
				});
		}
	}
}
