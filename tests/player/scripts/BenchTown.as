package
{
	import flash.display.MovieClip;

	public class Main extends MovieClip
	{
		public var loops:int = 0;
	}

	public class Character extends MovieClip
	{
		private var turns:int = 0;

		public function Character()
		{
			addFrameScript(0, first, totalFrames - 1, last);
		}

		private function first():void
		{
			turns++;
		}

		private function last():void
		{
			Main(root).loops++;
		}
	}
}
