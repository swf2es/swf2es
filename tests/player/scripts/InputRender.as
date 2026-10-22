package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.KeyboardEvent;
	import flash.events.MouseEvent;
	import flash.events.TimerEvent;
	import flash.events.TouchEvent;
	import flash.geom.Rectangle;
	import flash.utils.Timer;

	public class InputRender extends Sprite
	{
		private var cursor:Sprite = new Sprite();
		private var request:Boolean = true;
		private var invalidateInput:Boolean = true;
		private var invalidateRender:Boolean = false;
		private var requestFrame:Boolean = false;

		public function InputRender()
		{
			stage.frameRate = 5;
			cursor.name = "cursor";
			cursor.graphics.beginFill(0xFF0000);
			cursor.graphics.drawCircle(0, 0, 5);
			addChild(cursor);
			stage.addEventListener(MouseEvent.MOUSE_MOVE, input);
			stage.addEventListener(KeyboardEvent.KEY_DOWN, input);
			stage.addEventListener(TouchEvent.TOUCH_MOVE, input);
			addEventListener(Event.ENTER_FRAME, entering);
			addEventListener(Event.RENDER, rendering);
		}

		public function command(op:String):void
		{
			switch (op)
			{
				case "noUpdate":
					request = false;
					break;
				case "noInvalidate":
					invalidateInput = false;
					break;
				case "invalidateOnRender":
					invalidateRender = true;
					break;
				case "requestInFrame":
					requestFrame = true;
					break;
				case "scroll":
					cursor.scrollRect = new Rectangle(10, 20, 30, 40);
					break;
				case "timer":
					var timer:Timer = new Timer(20, 1);
					timer.addEventListener(TimerEvent.TIMER, input);
					timer.start();
					break;
			}
		}

		private function input(event:Event):void
		{
			trace(event.type + " begin");
			if (request)
			{
				if (event is MouseEvent)
				{
					MouseEvent(event).updateAfterEvent();
				}
				else if (event is KeyboardEvent)
				{
					KeyboardEvent(event).updateAfterEvent();
				}
				else if (event is TouchEvent)
				{
					TouchEvent(event).updateAfterEvent();
				}
				else if (event is TimerEvent)
				{
					TimerEvent(event).updateAfterEvent();
				}
			}

			if (invalidateInput)
			{
				stage.invalidate();
			}

			trace(event.type + " end");
		}

		private function entering(event:Event):void
		{
			trace("frame");
			if (requestFrame)
			{
				new MouseEvent(MouseEvent.MOUSE_MOVE).updateAfterEvent();
				stage.invalidate();
			}
		}

		private function rendering(event:Event):void
		{
			cursor.x = stage.mouseX;
			cursor.y = stage.mouseY;
			trace("render " + cursor.x + "," + cursor.y);
			if (invalidateRender)
			{
				stage.invalidate();
			}
		}
	}
}
