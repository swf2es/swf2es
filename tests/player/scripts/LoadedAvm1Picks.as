// The AS3 host of picksMovie and dragsMovie (tests/avm1-picks.ts): its
// Loader at the origin, a sprite in buttonMode beside the movie, and the
// mouse's events traced as AS3 hears them.
package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.KeyboardEvent;
	import flash.events.MouseEvent;
	import flash.net.URLRequest;

	public class LoadedAvm1Picks extends Sprite
	{
		private var ldr:Loader = new Loader();
		private var box:Sprite = new Sprite();
		private var overlay:Sprite = new Sprite();

		public function LoadedAvm1Picks()
		{
			ldr.name = "ldr";
			box.name = "box";
			box.graphics.beginFill(0xff0000);
			box.graphics.drawRect(0, 0, 60, 30);
			box.graphics.endFill();
			box.x = 190;
			box.y = 60;
			box.buttonMode = true;
			addChild(ldr);
			addChild(box);
			for each (var type:String in ["rollOver", "rollOut"])
			{
				ldr.addEventListener(type, log);
				box.addEventListener(type, log);
			}

			for each (type in ["mouseOver", "mouseOut", "mouseDown", "mouseUp", "click"])
			{
				stage.addEventListener(type, log);
			}

			overlay.name = "overlay";
			overlay.graphics.beginFill(0xff8800);
			overlay.graphics.drawRect(90, 0, 80, 50);
			overlay.graphics.endFill();
			overlay.visible = false;
			addChild(overlay);
			// A key shows or hides an overlay over c, as a press is held there.
			stage.addEventListener("keyDown", function(e:KeyboardEvent):void
				{
					overlay.visible = !overlay.visible;
					trace("as3:overlay " + overlay.visible);
				});
			ldr.load(new URLRequest("picks.swf"));
		}

		private function nameOf(o:Object):String
		{
			return o == null ? "null" : o == stage ? "stage" : o.name;
		}

		private function log(e:MouseEvent):void
		{
			trace("as3:" + e.type + " " + nameOf(e.target) + "@" + nameOf(e.currentTarget) + " related " + nameOf(e.relatedObject));
		}
	}
}
