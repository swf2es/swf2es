// A square drawn on the first frame, taken off on the second and its drawing
// cleared: from then on the stage holds nothing drawn, and Flash shows the
// SWF's background colour there.
package
{
	import flash.display.MovieClip;
	import flash.display.Shape;
	import flash.events.Event;

	public class EmptiedStage extends MovieClip
	{
		private var _square:Shape = new Shape();
		private var _frames:int = 0;

		public function EmptiedStage()
		{
			_square.graphics.beginFill(0x00ff00);
			_square.graphics.drawRect(10, 10, 30, 30);
			addChild(_square);
			graphics.beginFill(0x0000ff);
			graphics.drawRect(50, 10, 30, 30);
			addEventListener(Event.ENTER_FRAME, onEnterFrame);
		}

		private function onEnterFrame(e:Event):void
		{
			_frames++;
			if (_frames == 1)
			{
				removeChild(_square);
				graphics.clear();
				trace("emptied", numChildren);
			}
		}
	}
}
