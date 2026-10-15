// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/media/SoundTransform.ts.
// pan from Ruffle's (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/
// media/sound_transform.rs: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC
// and Ruffle contributors.

package flash.media
{
	public final class SoundTransform
	{
		public function SoundTransform(vol:Number = 1, panning:Number = 0)
		{
			this.volume = vol;
			this.pan = panning;
		}

		public native function get volume():Number;

		public native function set volume(volume:Number):void;

		public native function get leftToLeft():Number;

		public native function set leftToLeft(value:Number):void;

		public native function get leftToRight():Number;

		public native function set leftToRight(value:Number):void;

		public native function get rightToRight():Number;

		public native function set rightToRight(value:Number):void;

		public native function get rightToLeft():Number;

		public native function set rightToLeft(value:Number):void;

		// Pan is the four channels' mix: only the direct ones, as their square roots.
		public function get pan():Number
		{
			if (leftToRight != 0 || rightToLeft != 0)
			{
				return 0;
			}

			return 1 - leftToLeft * leftToLeft;
		}

		public function set pan(value:Number):void
		{
			leftToLeft = Math.sqrt(1 - value);
			rightToRight = Math.sqrt(1 + value);
			leftToRight = 0;
			rightToLeft = 0;
		}
	}
}
