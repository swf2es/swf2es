package
{
	import flash.display.MovieClip;

	public class WalkMain extends MovieClip
	{
		public var n:int = 0;

		public function WalkMain()
		{
			addFrameScript(0, tick, 1, tick);
		}

		private function tick():void
		{
			n++;
		}
	}

	public class WalkPart extends MovieClip
	{
		public static var made:int = 0;

		public function WalkPart()
		{
			addFrameScript(0, first);
		}

		private function first():void
		{
			made++;
		}
	}
}
