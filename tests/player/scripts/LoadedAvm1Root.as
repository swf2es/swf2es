// The AS3 host of an AVM1 movie that names its root and levels: a Loader
// named ldr loads root.swf, and once the movie has run a while, how many
// children the Loader has, as a level the movie loads would add one.
package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.net.URLRequest;

	public class LoadedAvm1Root extends Sprite
	{
		private var ldr:Loader = new Loader();
		private var frames:int = 0;

		public function LoadedAvm1Root()
		{
			ldr.name = "ldr";
			ldr.load(new URLRequest("root.swf"));
			addChild(ldr);
			addEventListener(Event.ENTER_FRAME, frame);
		}

		private function frame(e:Event):void
		{
			if (++frames == 12)
			{
				removeEventListener(Event.ENTER_FRAME, frame);
				trace("as3:children " + ldr.numChildren + " " + ldr.content.name);
			}
		}
	}
}
