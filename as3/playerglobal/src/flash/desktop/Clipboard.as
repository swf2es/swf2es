// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/desktop/Clipboard.ts.

package flash.desktop
{
	[API("661", "662")]
	public class Clipboard
	{
		public function Clipboard()
		{
		}

		public static native function get generalClipboard():Clipboard;

		public native function get formats():Array;

		public native function clear():void;

		public native function clearData(format:String):void;

		public native function setData(format:String, data:Object, serializable:Boolean = true):Boolean;

		public native function setDataHandler(format:String, handler:Function, serializable:Boolean = true):Boolean;

		public native function getData(format:String, transferMode:String = "originalPreferred"):Object;

		public native function hasFormat(format:String):Boolean;

		[API("668")]
		public native function get supportsFilePromise():Boolean;
	}
}
