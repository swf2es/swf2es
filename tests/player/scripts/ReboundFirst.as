// The first frame's code of symbol-class-rebound: the document class and a
// class bound to a sprite, each bound again to another class by the second
// frame's SymbolClass (ReboundSecond.as). Flash keeps the first binding:
// the root stays this class and the sprite placed in frame 2 makes a
// ReboundBoxA, while either class's new still has the sprite's child.
package
{
	import flash.display.DisplayObjectContainer;
	import flash.display.MovieClip;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.utils.getDefinitionByName;
	import flash.utils.getQualifiedClassName;

	public class ReboundBoxA extends Sprite
	{
		public function ReboundBoxA()
		{
			trace("ReboundBoxA", numChildren);
		}
	}

	public class ReboundFirst extends MovieClip
	{
		private var _ticks:int = 0;

		public function ReboundFirst()
		{
			trace("ReboundFirst", currentFrame);
			addEventListener(Event.ENTER_FRAME, tick);
		}

		private function tick(event:Event):void
		{
			_ticks++;
			trace("tick", _ticks, currentFrame, getQualifiedClassName(root), root == this);
			if (_ticks == 2)
			{
				const a:Class = getDefinitionByName("ReboundBoxA") as Class;
				const b:Class = getDefinitionByName("ReboundBoxB") as Class;
				trace("new", DisplayObjectContainer(new a()).numChildren, DisplayObjectContainer(new b()).numChildren);
			}

			if (_ticks == 3)
			{
				stop();
			}
		}
	}
}
