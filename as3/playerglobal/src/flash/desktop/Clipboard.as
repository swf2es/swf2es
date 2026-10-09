// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/desktop/Clipboard.ts.

package flash.desktop
{
	import flash.display.BitmapData;
	import flash.utils.ByteArray;
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

		// The player's natives (packages/player/src/playerglobal/flash/desktop/Clipboard.ts).
		private native function get alive():Boolean;

		private native function get canReadContents():Boolean;

		private native function get canWriteContents():Boolean;

		private native function nativeSetHandler(format:String, handler:Function):void;

		private native function getObjectReference(format:String):Object;

		private native function putObjectReference(format:String, value:Object):void;

		private native function getString():String;

		private native function putString(text:String):void;

		private native function getHTML():String;

		private native function putHTML(html:String):void;

		private native function getRTF():ByteArray;

		private native function putRTF(bytes:ByteArray):void;

		private native function getByteArray(format:String):ByteArray;

		private native function putByteArray(format:String, bytes:ByteArray):void;

		private native function get swfVersion():int;

		private native function setHandlerStoringData(storing:Boolean):void;

		private native function getURL():String;

		private native function putURL(url:String):void;

		private native function getBitmapData():BitmapData;

		private native function putBitmapData(arg0:BitmapData):void;

		private native function getFileList():Array;

		private native function nativePutFileList(arg0:Array):void;

		private native function nativeGetFilePromiseList():Array;

		private native function nativePutFilePromiseList(arg0:Array):void;
	}
}
