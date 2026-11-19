// When a script registered for the frame its clip is on runs, in a SWF of
// version 10: b, a and c are Kids on the root, stopped on their first
// frame. a's first frame's script registers c's, then b's, after the walk
// passed b and before it reaches c; an EXIT_FRAME listener registers a's
// again, outside the frame scripts; the root's fourth frame sends a to its
// second, whose script registers b's first again in the goto's cycle; an
// ENTER_FRAME listener on the fifth sends c to its second, which does too,
// and then stops listening: the cycles' EXIT_FRAMEs count as frames to the
// oracle's harness, which ends its run early by as many.
package
{
	import flash.display.MovieClip;
	import flash.events.Event;

	public class Kid extends MovieClip
	{
		public function Kid()
		{
			stop();
			if (name == "a")
			{
				addFrameScript(0, first, 1, second);
			}
			else if (name == "c")
			{
				addFrameScript(1, second);
			}
		}

		private function first():void
		{
			trace(name, "frame 1 registers c's frame 1, then b's");
			const root:MovieClip = MovieClip(parent);
			root.c.addFrameScript(0, root.c.late);
			root.b.addFrameScript(0, root.b.late);
		}

		private function second():void
		{
			trace(name, "frame 2 registers b's frame 1");
			const root:MovieClip = MovieClip(parent);
			root.b.addFrameScript(0, root.b.late);
		}

		public function late():void
		{
			trace(name, "late frame 1");
		}

		public function again():void
		{
			trace(name, "frame 1 again");
		}
	}

	public class Main extends MovieClip
	{
		public var a:MovieClip;
		public var b:MovieClip;
		public var c:MovieClip;
		private var sent:Boolean = false;

		public function Main()
		{
			addFrameScript(0, frame1, 3, frame4, 4, frame5);
			addEventListener(Event.ENTER_FRAME, onEnter);
			addEventListener(Event.EXIT_FRAME, onExit);
		}

		private function frame1():void
		{
			trace("main frame 1");
		}

		private function frame4():void
		{
			trace("main frame 4 sends a to 2");
			a.gotoAndStop(2);
			trace("main frame 4 after goto");
		}

		private function frame5():void
		{
			trace("main frame 5");
			stop();
		}

		private function onEnter(event:Event):void
		{
			trace("enter", currentFrame);
			if (currentFrame == 5 && !sent)
			{
				sent = true;
				trace("enter sends c to 2");
				c.gotoAndStop(2);
				trace("enter after goto");
				removeEventListener(Event.ENTER_FRAME, onEnter);
				removeEventListener(Event.EXIT_FRAME, onExit);
			}
		}

		private function onExit(event:Event):void
		{
			trace("exit", currentFrame);
			if (currentFrame == 2)
			{
				trace("exit registers a's frame 1 again");
				a.addFrameScript(0, a.again);
			}
		}
	}
}
