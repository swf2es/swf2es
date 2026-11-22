package
{
	import flash.display.Sprite;
	import flash.events.MouseEvent;

	public class MouseLockInput extends Sprite
	{
		public var unlockOnMove:Boolean;
		public var lastWheel:Boolean;

		public function MouseLockInput()
		{
			var box:Sprite = new Sprite();
			box.name = "box";
			box.graphics.beginFill(0xff00ff);
			box.graphics.drawRect(0, 0, 100, 100);
			addChild(box);
			for each (var type:String in ["mouseMove", "mouseDown", "mouseUp", "click", "rightMouseDown", "mouseWheel"])
			{
				stage.addEventListener(type, report);
			}
		}

		private function report(e:MouseEvent):void
		{
			trace(e.type, e.target == stage ? "stage" : e.target.name,
				e.localX, e.localY, e.stageX, e.stageY, Object(e).movementX, Object(e).movementY,
				stage.mouseX, stage.mouseY);
			if (unlockOnMove && e.type == MouseEvent.MOUSE_MOVE)
			{
				unlockOnMove = false;
				stage.mouseLock = false;
			}
			if (lastWheel && e.type == MouseEvent.MOUSE_WHEEL)
			{
				stage.removeEventListener(MouseEvent.MOUSE_WHEEL, report);
			}
		}
	}
}
