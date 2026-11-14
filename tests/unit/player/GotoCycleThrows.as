package
{
	import flash.display.MovieClip;
	import flash.events.Event;
	public class Bound extends MovieClip
	{
		public function Bound()
		{
			addFrameScript(1, function():void
				{
					trace("Bound script 2, goto 3");
					gotoAndStop(3);
					trace("Bound after its goto", currentFrame);
				}, 2, function():void
				{
					trace("Bound script 3 throws");
					throw new Error("from script 3");
				}, 3, function():void
				{
					trace("Bound script 4 throws");
					throw new Error("from script 4");
				});
		}
	}
	public class Main extends MovieClip
	{
		public var bound:Bound;
		private var n:int = 0;
		public function Main()
		{
			addFrameScript(2, function():void
				{
					try
					{
						trace("Main script 3, goto 4");
						bound.gotoAndStop(4);
						trace("Main script after goto", bound.currentFrame);
					}
					catch (error:Error)
					{
						trace("Main script caught", error.message);
					}
				});
			addEventListener(Event.ENTER_FRAME, enter);
		}
		private function enter(e:Event):void
		{
			n++;
			if (n == 1)
			{
				try
				{
					trace("Main listener, goto 2");
					bound.gotoAndStop(2);
					trace("Main listener after goto", bound.currentFrame);
				}
				catch (error:Error)
				{
					trace("Main listener caught", error.message);
				}
			}
			else if (n == 3)
			{
				bound.gotoAndStop(1);
				try
				{
					trace("Main listener, goto 3");
					bound.gotoAndStop(3);
					trace("Main listener after goto", bound.currentFrame);
				}
				catch (error:Error)
				{
					trace("Main listener caught", error.message);
				}
				removeEventListener(Event.ENTER_FRAME, enter);
			}
		}
	}
}
