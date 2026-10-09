// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/media/SoundTransform.ts.

package flash.media
{
	public final class SoundTransform
	{
		public function SoundTransform(vol:Number = 1, panning:Number = 0)
		{
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

		public native function get pan():Number;

		public native function set pan(value:Number):void;
	}
}
