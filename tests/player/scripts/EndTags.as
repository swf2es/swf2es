// Where AS3 timelines loop: the root, without an End tag, holds s1, of two
// frames without one, s2, whose header says three frames but whose
// ShowFrame tags end two, before its End tag, s3, whose header says three
// with one ShowFrame, and s4, of two frames and an End tag. Each frame
// traces where they are, six times.
package
{
	import flash.display.MovieClip;
	import flash.events.Event;

	public class Main extends MovieClip
	{
		public var s1:MovieClip;
		public var s2:MovieClip;
		public var s3:MovieClip;
		public var s4:MovieClip;
		private var count:int = 0;

		public function Main()
		{
			addFrameScript(0, frame1, 1, frame2);
			addEventListener(Event.ENTER_FRAME, onEnter);
		}

		private function frame1():void
		{
			trace("main frame 1");
		}

		private function frame2():void
		{
			trace("main frame 2");
		}

		private function onEnter(event:Event):void
		{
			trace("root", currentFrame, totalFrames, "s1", s1.currentFrame, s1.totalFrames, "s2",
				s2.currentFrame, s2.totalFrames, s2.framesLoaded, "s3", s3.currentFrame,
				s3.totalFrames, "s4", s4.currentFrame);
			if (++count == 6)
			{
				removeEventListener(Event.ENTER_FRAME, onEnter);
			}
		}
	}
}
