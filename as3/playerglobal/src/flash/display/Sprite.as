// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/Sprite.ts.

package flash.display
{
	import flash.geom.Rectangle;
	import flash.media.SoundTransform;

	public class Sprite extends DisplayObjectContainer
	{
		public function Sprite()
		{
		}

		public native function get graphics():Graphics;

		public native function get buttonMode():Boolean;

		public native function set buttonMode(buttonMode:Boolean):void;

		public native function startDrag(lockCenter:Boolean = false, bounds:Rectangle = null):void;

		public native function stopDrag():void;

		[API("667")]
		public native function startTouchDrag(touchPointID:int, lockCenter:Boolean = false, bounds:Rectangle = null):void;

		[API("667")]
		public native function stopTouchDrag(touchPointID:int):void;

		public native function get dropTarget():DisplayObject;

		public native function get hitArea():Sprite;

		public native function set hitArea(hitArea:Sprite):void;

		public native function get useHandCursor():Boolean;

		public native function set useHandCursor(useHandCursor:Boolean):void;

		public native function get soundTransform():SoundTransform;

		public native function set soundTransform(sndTransform:SoundTransform):void;

		// The player's natives (packages/player/src/playerglobal/flash/display/Sprite.ts).
		private native function constructChildren():void;
	}
}
