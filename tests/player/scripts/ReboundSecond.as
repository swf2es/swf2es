// The second frame's code of symbol-class-rebound (ReboundFirst.as): what
// its SymbolClass binds to the document's and the sprite's ids again.
package
{
	import flash.display.MovieClip;
	import flash.display.Sprite;

	public class ReboundBoxB extends Sprite
	{
		public function ReboundBoxB()
		{
			trace("ReboundBoxB", numChildren);
		}
	}

	public class ReboundSecond extends MovieClip
	{
		public function ReboundSecond()
		{
			trace("ReboundSecond");
		}
	}
}
