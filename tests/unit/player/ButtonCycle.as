package
{
	import flash.display.MovieClip;
	import flash.display.Shape;
	import flash.display.SimpleButton;
	import flash.display.Sprite;
	import flash.events.Event;

	public class ButtonCycle extends MovieClip
	{
		private var f:int = 0;
		private var a:Sprite;
		private var b:Sprite;

		public function ButtonCycle()
		{
			a = new Sprite();
			a.addChild(new MovieClip());
			var ba:SimpleButton = new SimpleButton(new Shape(), new Shape(), new Shape(), new Shape());
			a.addChild(ba);
			try
			{
				ba.upState = a;
				trace("off: set; a.parent", a.parent, "upState is a", ba.upState == a);
			}
			catch (e:Error)
			{
				trace("off: threw", e.errorID);
			}
			b = new Sprite();
			addChild(b);
			var bb:SimpleButton = new SimpleButton(new Shape(), new Shape(), new Shape(), new Shape());
			b.addChild(bb);
			try
			{
				bb.upState = b;
				trace("on: set; b.parent is this", b.parent == this, "upState is b", bb.upState == b);
			}
			catch (e:Error)
			{
				trace("on: threw", e.errorID);
			}
			try
			{
				bb.overState = b;
				trace("on: over set");
			}
			catch (e:Error)
			{
				trace("on: over threw", e.errorID);
			}
			addEventListener(Event.ENTER_FRAME, enter);
		}

		private function enter(e:Event):void
		{
			f++;
			trace("frame", f, "a.parent", a.parent, "b.parent is this", b.parent == this, "b in stage", b.stage != null);
			if (f == 2)
			{
				a.addChild(new MovieClip());
				b.addChild(new MovieClip());
				trace("added under the cycles");
			}
		}
	}
}
