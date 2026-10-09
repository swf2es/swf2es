// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/SimpleButton.ts.

package flash.display
{
	import flash.media.SoundTransform;

	public class SimpleButton extends InteractiveObject
	{
		public function SimpleButton(upState:DisplayObject = null, overState:DisplayObject = null, downState:DisplayObject = null, hitTestState:DisplayObject = null)
		{
		}

		public native function get useHandCursor():Boolean;

		public native function set useHandCursor(value:Boolean):void;

		public native function get enabled():Boolean;

		public native function set enabled(value:Boolean):void;

		public native function get trackAsMenu():Boolean;

		public native function set trackAsMenu(value:Boolean):void;

		public native function get upState():DisplayObject;

		public native function set upState(value:DisplayObject):void;

		public native function get overState():DisplayObject;

		public native function set overState(value:DisplayObject):void;

		public native function get downState():DisplayObject;

		public native function set downState(value:DisplayObject):void;

		public native function get hitTestState():DisplayObject;

		public native function set hitTestState(value:DisplayObject):void;

		public native function get soundTransform():SoundTransform;

		public native function set soundTransform(sndTransform:SoundTransform):void;

		// The player's natives (packages/player/src/playerglobal/flash/display/SimpleButton.ts).
		private native function _updateButton():void;
	}
}
