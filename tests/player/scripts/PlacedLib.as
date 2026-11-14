package
{
	import flash.display.DisplayObject;
	import flash.display.MovieClip;

	public class PlacedButton extends MovieClip
	{
		public var face:DisplayObject;

		public function PlacedButton()
		{
			super();
			trace("PlacedButton", name, numChildren, face != null, parent != null);
		}
	}
}

package
{
	public class PlacedButtonSub extends PlacedButton
	{
		public function PlacedButtonSub()
		{
			super();
			trace("PlacedButtonSub", name, numChildren);
		}
	}
}

package
{
	import flash.display.Sprite;

	public class PlacedPlain extends Sprite
	{
		public function PlacedPlain()
		{
			super();
			graphics.beginFill(0x00aa00);
			graphics.drawRect(0, 0, 20, 20);
			trace("PlacedPlain", name, numChildren, parent != null);
		}
	}
}
