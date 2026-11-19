// Which scripts after the walk run, and how often, in a SWF of version 9
// (late-queue-9) or 10 (late-queue): a, b, c, d and e are Clips of three
// frames on a root of five, all stopped but b, which plays and has a script
// on its third frame alone. The root's second frame sends b, on a frame
// without a script, to its third; the third sends c to 2 then 3, and d to
// 2 then 1; the fourth registers e's first frame's script twice in one
// call, then again, and c's third and first in one call; the fifth
// registers a's and d's first frames' scripts again, whose frames ran
// theirs, and sends e to its second.
package
{
	import flash.display.MovieClip;
	import flash.events.Event;

	public dynamic class Clip extends MovieClip
	{
		public function Clip()
		{
			if (name == "b")
			{
				addFrameScript(2, frame3);
				return;
			}

			stop();
			addFrameScript(0, frame1, 1, frame2, 2, frame3);
		}

		private function frame1():void
		{
			trace(name, "frame 1");
		}

		private function frame2():void
		{
			trace(name, "frame 2");
		}

		private function frame3():void
		{
			trace(name, "frame 3");
			stop();
		}

		public function g():void
		{
			trace(name, "g");
		}

		public function h():void
		{
			trace(name, "h");
		}
	}

	public class Main extends MovieClip
	{
		public var a:MovieClip;
		public var b:MovieClip;
		public var c:MovieClip;
		public var d:MovieClip;
		public var e:MovieClip;

		public function Main()
		{
			addFrameScript(0, frame1, 1, frame2, 2, frame3, 3, frame4, 4, frame5);
			addEventListener(Event.EXIT_FRAME, onExit);
		}

		private function frame1():void
		{
			trace("main frame 1");
		}

		private function frame2():void
		{
			trace("main frame 2 sends b, on", b.currentFrame, "to 3");
			b.gotoAndPlay(3);
			trace("main frame 2 sent b");
		}

		private function frame3():void
		{
			trace("main frame 3 sends c to 2, 3 and d to 2, 1");
			c.gotoAndStop(2);
			c.gotoAndStop(3);
			d.gotoAndStop(2);
			d.gotoAndStop(1);
			trace("main frame 3 sent them");
		}

		private function frame4():void
		{
			trace("main frame 4 registers e's and c's");
			e.addFrameScript(0, e.g, 0, e.h);
			e.addFrameScript(0, e.h);
			c.addFrameScript(2, c.g, 0, c.h);
			trace("main frame 4 registered them");
		}

		private function frame5():void
		{
			trace("main frame 5 registers a's and d's, sends e to 2");
			a.addFrameScript(0, a.g);
			d.addFrameScript(0, d.g);
			e.gotoAndStop(2);
			trace("main frame 5 sent e");
			stop();
		}

		private function onExit(event:Event):void
		{
			trace("exit", currentFrame);
			if (currentFrame == 5)
			{
				removeEventListener(Event.EXIT_FRAME, onExit);
			}
		}
	}
}
