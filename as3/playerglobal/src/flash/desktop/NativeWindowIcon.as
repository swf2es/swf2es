// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.desktop
{
	[API("661")]
	public class NativeWindowIcon extends InteractiveIcon
	{
		public function NativeWindowIcon()
		{
		}

		override public native function set bitmaps(arg0:Array):void;
		override public native function get bitmaps():Array;
		override public native function get width():int;
		override public native function get height():int;
	}
}
