package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.TimerEvent;
	import flash.utils.Timer;
	import flash.utils.getTimer;
	public class TimerPace extends Sprite
	{
		private var log:Array = [];
		public function TimerPace()
		{
			start("b", 10);
			start("a", 10);
			start("c", 30);
			start("d", 50);
			addEventListener(Event.ENTER_FRAME, function(e:Event):void
				{
					trace(log.join(" "));
					log = ["EF" + getTimer()];
				});
			addEventListener(Event.FRAME_CONSTRUCTED, function(e:Event):void
				{
					log.push("FC");
				});
		}
		private function start(name:String, delay:int):void
		{
			var t:Timer = new Timer(delay);
			t.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void
				{
					log.push(name + getTimer());
				});
			t.start();
		}
	}
}
