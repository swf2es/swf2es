package
{
	import flash.display.DisplayObject;
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.MouseEvent;
	import flash.external.ExternalInterface;
	import flash.geom.Matrix;
	import flash.geom.Rectangle;
	import flash.net.URLRequest;

	public class LoadedAvm1Input extends Sprite
	{
		private var a:Loader = new Loader();
		private var b:Loader = new Loader();
		private var overlay:Sprite = new Sprite();

		public function LoadedAvm1Input()
		{
			a.x = a.y = 50;
			a.scaleX = a.scaleY = 2;
			addChild(a);
			b.x = b.y = 50;
			b.scaleX = b.scaleY = 2;
			overlay.graphics.beginFill(0xff0000);
			overlay.graphics.drawRect(50, 50, 80, 60);
			overlay.graphics.endFill();
			overlay.visible = false;
			addChild(overlay);
			for each (var d:DisplayObject in [a, overlay])
			{
				d.name = d === a ? "loader" : "overlay";
				for each (var type:String in ["mouseDown", "mouseUp", "click"])
				{
					d.addEventListener(type, event);
				}
			}
			a.load(new URLRequest("one.swf"));
			if (ExternalInterface.available)
			{
				ExternalInterface.addCallback("control", control);
			}
		}

		private function event(e:MouseEvent):void
		{
			var line:String = "as3:" + e.currentTarget.name + ":" + e.type;
			trace(line);
			if (ExternalInterface.available)
			{
				ExternalInterface.call("record", line);
			}
		}

		public function control(s:String):void
		{
			switch (s)
			{
				case "overlay":
					overlay.visible = true;
					break;
				case "overlayOff":
					overlay.visible = false;
					break;
				case "overlayDisabled":
					overlay.mouseEnabled = false;
					break;
				case "loaderDisabled":
					a.mouseEnabled = false;
					break;
				case "childrenDisabled":
					a.mouseChildren = false;
					break;
				case "parentDisabled":
					mouseChildren = false;
					break;
				case "invisible":
					a.visible = false;
					break;
				case "remove":
					removeChild(a);
					break;
				case "readd":
					addChildAt(a, 0);
					break;
				case "unload":
					a.unload();
					break;
				case "second":
					addChild(b);
					b.load(new URLRequest("two.swf"));
					break;
				case "transform":
					a.transform.matrix = new Matrix(0, 2, -2, 0, 200, 50);
					break;
				case "scroll":
					a.scrollRect = new Rectangle(0, 0, 5, 30);
					break;
				case "mask":
					var clip:Sprite = new Sprite();
					clip.graphics.beginFill(0);
					clip.graphics.drawRect(50, 50, 10, 60);
					clip.graphics.endFill();
					addChild(clip);
					a.mask = clip;
					break;
			}
		}
	}
}
