// What a timeline places is named as it is placed, its clips' first frames
// too, depth first, before the document class's field initializers run.
package
{
	import flash.display.DisplayObject;
	import flash.display.DisplayObjectContainer;
	import flash.display.MovieClip;
	import flash.display.Sprite;

	public class InstanceNamesTimeline extends MovieClip
	{
		public var named:*;
		public var early:Sprite = new Sprite();

		public function InstanceNamesTimeline()
		{
			trace("early " + early.name);
			for (var i:int = 0; i < numChildren; i++)
			{
				trace("child " + i + " " + names(getChildAt(i)));
			}

			trace("new " + new Sprite().name);
			stop();
		}

		private function names(d:DisplayObject):String
		{
			var line:String = d.name;
			var c:DisplayObjectContainer = d as DisplayObjectContainer;
			if (c)
			{
				for (var i:int = 0; i < c.numChildren; i++)
				{
					line += " [" + names(c.getChildAt(i)) + "]";
				}
			}

			return line;
		}
	}
}
