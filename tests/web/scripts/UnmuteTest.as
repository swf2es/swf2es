package
{
	import flash.display.MovieClip;
	import flash.events.MouseEvent;

	// The web test's unmute SWF, its root's frames a streamed tone: each press
	// the stage hears, which a press on the element's unmute button must not be.
	public class UnmuteTest extends MovieClip
	{
		public function UnmuteTest()
		{
			graphics.beginFill(0x3060a0);
			graphics.drawRect(0, 0, 200, 150);
			stage.addEventListener(MouseEvent.MOUSE_DOWN, function(e:MouseEvent):void
				{
					trace("unmute: down " + e.stageX + " " + e.stageY);
				});
		}
	}
}
