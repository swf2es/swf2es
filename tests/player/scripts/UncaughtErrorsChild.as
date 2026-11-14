// The SWF scripts/UncaughtErrors.as.template loads: what it throws and
// dispatches is its own LoaderInfo's to tell, whoever asked for it.
package
{
	import flash.display.MovieClip;
	import flash.events.Event;
	import flash.events.EventDispatcher;
	import flash.events.IOErrorEvent;
	import flash.events.TimerEvent;
	import flash.events.UncaughtErrorEvent;
	import flash.net.URLLoader;
	import flash.net.URLRequest;
	import flash.utils.Timer;

	public class UncaughtErrorsChild extends MovieClip
	{
		public function UncaughtErrorsChild()
		{
			loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, function(e:UncaughtErrorEvent):void
				{
					trace("  the child hears its own: phase " + e.eventPhase + ", its LoaderInfo the target " + (e.target == loaderInfo)
							+ " and the current target " + (e.currentTarget == loaderInfo));
				});
		}

		public function fail(what:String):void
		{
			throw new Error("the child's " + what);
		}

		/** In the child's next enterFrame listener: `f` called, or an Error thrown. */
		public function later(what:String, f:Function = null):void
		{
			var self:MovieClip = this;
			addEventListener(Event.ENTER_FRAME, function(e:Event):void
				{
					self.removeEventListener(Event.ENTER_FRAME, arguments.callee);
					if (f != null)
					{
						f();
					}
					else
					{
						throw new Error("the child's " + what);
					}
				});
		}

		public function timer(what:String):void
		{
			var t:Timer = new Timer(1, 1);
			t.addEventListener(TimerEvent.TIMER, function(e:Event):void
				{
					throw new Error("the child's " + what);
				});
			t.start();
		}

		public function unheard():void
		{
			trace("the child's dispatch returns", new EventDispatcher().dispatchEvent(
						new IOErrorEvent(IOErrorEvent.IO_ERROR, false, false, "the child's", 9)));
		}

		public function load():void
		{
			new URLLoader().load(new URLRequest("missing-for-the-child.txt"));
		}
	}
}
