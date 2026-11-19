// A Sprite in button mode whose graphic is a shape tween pulsing every
// frame: what it hears of the pointer, for the page to read.
package
{
	import flash.display.MovieClip;
	import flash.events.MouseEvent;
	import flash.external.ExternalInterface;

	public class TweenHoverTest extends MovieClip
	{
		// The timeline's tween, which Flash sets on the document class.
		public var btn:MovieClip;

		private const _log:Array = [];

		public function TweenHoverTest()
		{
			btn.buttonMode = true;
			btn.addEventListener(MouseEvent.ROLL_OVER, heard);
			btn.addEventListener(MouseEvent.ROLL_OUT, heard);
			btn.addEventListener(MouseEvent.MOUSE_OVER, heard);
			btn.addEventListener(MouseEvent.MOUSE_OUT, heard);
			ExternalInterface.addCallback("hoverLog", hoverLog);
		}

		private function heard(e:MouseEvent):void
		{
			_log.push(e.type);
		}

		private function hoverLog():String
		{
			return _log.join(" ");
		}
	}
}
