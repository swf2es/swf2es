package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.media.Sound;
	import flash.media.SoundMixer;
	import flash.media.SoundTransform;
	import flash.utils.getDefinitionByName;
	public class Main extends Sprite
	{
		private var frame:int = 0;
		public function Main()
		{
			tone().play(0, 0, new SoundTransform(0.5));
			addEventListener(Event.ENTER_FRAME, onFrame);
		}
		private function tone():Sound
		{
			return new (getDefinitionByName("Tone") as Class)() as Sound;
		}
		private function onFrame(event:Event):void
		{
			frame++;
			if (frame == 1)
			{
				var global:SoundTransform = new SoundTransform(0.5);
				global.leftToLeft = 0.75;
				global.leftToRight = 0.25;
				global.rightToLeft = 0.5;
				global.rightToRight = 0.5;
				SoundMixer.soundTransform = global;
				var own:SoundTransform = new SoundTransform(-0.5);
				own.leftToRight = 0.5;
				tone().play(0, 0, own);
			}
			else if (frame == 2)
			{
				SoundMixer.stopAll();
			}
		}
	}
}
