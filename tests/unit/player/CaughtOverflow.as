package
{
	import flash.display.MovieClip;
	public class Bound extends MovieClip
	{
		public static var runs:int = 0;
		public function Bound()
		{
			addFrameScript(0, swap, 1, swap);
		}
		private function swap():void
		{
			runs++;
			var peer:MovieClip = MovieClip(parent).getChildByName(name == "a" ? "b" : "a") as MovieClip;
			try
			{
				peer.gotoAndStop(peer.currentFrame == 1 ? 2 : 1);
			}
			catch (e:Error)
			{
			}
		}
	}
	public class Main extends MovieClip
	{
		public var a:Bound;
		public var b:Bound;
		public function Main()
		{
			addEventListener("exitFrame", function(_:*):void
				{
					trace("runs", Bound.runs);
				});
		}
	}
}
