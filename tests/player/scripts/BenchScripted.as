package
{
	import flash.display.MovieClip;
	import flash.geom.ColorTransform;

	public class Main extends MovieClip
	{
		public var frames:int = 0;

		public function Main()
		{
			addFrameScript(0, frame, 1, frame);
		}

		private function frame():void
		{
			frames++;
		}

		public var colors:Object = {skin: 0xe0b090, hair: 0x603010, cloth: 0x3050a0, trim: 0xc0c040};

		public function setColor(mc:MovieClip):void
		{
			var c:uint = colors[mc.kind];
			var ct:ColorTransform = mc.transform.colorTransform;
			ct.redMultiplier = ((c >> 16) & 255) / 255;
			ct.greenMultiplier = ((c >> 8) & 255) / 255;
			ct.blueMultiplier = (c & 255) / 255;
			mc.transform.colorTransform = ct;
		}
	}

	public class Part extends MovieClip
	{
		private static const KINDS:Array = ["skin", "hair", "cloth", "trim"];
		private static var made:int = 0;
		public var kind:String;

		public function Part()
		{
			kind = KINDS[made++ & 3];
			addFrameScript(0, frame1);
		}

		private function frame1():void
		{
			MovieClip(root).setColor(this);
		}
	}
}
