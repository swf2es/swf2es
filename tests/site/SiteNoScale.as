// A SWF that asks for noScale and the top left, as a game laid out for its
// own size does (stage3d.ts: the site shows it at that size).
package
{
	import flash.display.Sprite;

	public class SiteNoScale extends Sprite
	{
		public function SiteNoScale()
		{
			stage.scaleMode = "noScale";
			stage.align = "TL";
			graphics.beginFill(0x3366cc);
			graphics.drawRect(0, 0, 96, 96);
			graphics.endFill();
			trace("site-noscale ready");
		}
	}
}
