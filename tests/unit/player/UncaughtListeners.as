package
{
	import flash.display.Loader;
	import flash.display.MovieClip;
	import flash.events.Event;
	import flash.events.EventDispatcher;
	import flash.events.TimerEvent;
	import flash.system.LoaderContext;
	import flash.utils.ByteArray;
	import flash.utils.Timer;
	public class Main extends MovieClip
	{
		private var timer:Timer;
		public function Main()
		{
			var d:EventDispatcher = new EventDispatcher();
			d.addEventListener("x", function(e:Event):void
				{
					trace("x1 throws");
					throw new Error("from x1");
				});
			d.addEventListener("x", function(e:Event):void
				{
					trace("x2 ran");
				});
			trace("dispatch returned", d.dispatchEvent(new Event("x")));
			// An empty SWF of version 10: header, a zero rectangle, 12 fps, one frame, FileAttributes, ShowFrame, End.
			var swf:ByteArray = new ByteArray();
			for each (var b:int in [0x46, 0x57, 0x53, 10, 23, 0, 0, 0, 0, 0, 12, 1, 0, 0x44, 0x11, 8, 0, 0, 0, 0x40, 0, 0, 0])
			{
				swf.writeByte(b);
			}
			var loader:Loader = new Loader();
			loader.contentLoaderInfo.addEventListener(Event.INIT, function(e:Event):void
				{
					trace("init1 throws");
					throw new Error("from init1");
				});
			loader.contentLoaderInfo.addEventListener(Event.INIT, function(e:Event):void
				{
					trace("init2");
				});
			loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					trace("complete");
					timer = new Timer(20, 2);
					timer.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void
						{
							trace("timer1 throws", timer.currentCount);
							throw new Error("from timer1");
						});
					timer.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void
						{
							trace("timer2", timer.currentCount);
						});
					timer.addEventListener(TimerEvent.TIMER_COMPLETE, function(e:TimerEvent):void
						{
							trace("timer complete", timer.running);
						});
					timer.start();
				});
			var context:LoaderContext = new LoaderContext();
			context.allowCodeImport = true;
			loader.loadBytes(swf, context);
		}
	}
}
