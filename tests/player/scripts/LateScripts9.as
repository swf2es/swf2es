// Gotos as frame scripts run in a SWF of version 9: p, a and q are Clips
// on the root, stopped on their first frame, a Clip's fourth frame placing
// a Kid. p's first frame's script sends a to its fourth frame, then q to
// its second, after the walk passed p and before it reaches a and q. The
// root's second frame places a Clip d, and its script sends p, whose
// script ran, to its second frame, and the root to its third, which places
// a Clip r.
package
{
	import flash.display.MovieClip;

	public dynamic class Clip extends MovieClip
	{
		public function Clip()
		{
			stop();
			addFrameScript(0, frame1, 1, frame2, 3, frame4);
		}

		private function frame1():void
		{
			trace(name, "frame 1");
			if (name == "p")
			{
				trace("p sends a to 4, then q to 2");
				MovieClip(parent).a.gotoAndStop(4);
				MovieClip(parent).q.gotoAndStop(2);
				trace("p sent them");
			}
		}

		private function frame2():void
		{
			trace(name, "frame 2");
		}

		private function frame4():void
		{
			trace(name, "frame 4");
		}
	}

	public class Kid extends MovieClip
	{
		public function Kid()
		{
			trace("kid made");
			addFrameScript(0, frame1);
		}

		private function frame1():void
		{
			trace("kid frame 1");
		}
	}

	public class Main extends MovieClip
	{
		public var p:MovieClip;
		public var a:MovieClip;
		public var q:MovieClip;
		public var d:MovieClip;
		public var r:MovieClip;

		public function Main()
		{
			addFrameScript(0, frame1, 1, frame2, 2, frame3);
		}

		private function frame1():void
		{
			trace("main frame 1");
		}

		private function frame2():void
		{
			trace("main frame 2 sends p to 2, goes to 3");
			p.gotoAndStop(2);
			gotoAndStop(3);
			trace("main frame 2 after goto");
		}

		private function frame3():void
		{
			trace("main frame 3");
		}
	}
}
