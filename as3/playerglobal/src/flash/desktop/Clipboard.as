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

		public function setData(format:String, data:Object, serializable:Boolean = true):Boolean
		{
			checkWrite();
			switch (format)
			{
				case ClipboardFormats.TEXT_FORMAT:
					putString(String(data));
					break;
				case ClipboardFormats.HTML_FORMAT:
					putHTML(String(data));
					break;
				case ClipboardFormats.RICH_TEXT_FORMAT:
					putRTF(data as ByteArray);
					break;
				case ClipboardFormats.URL_FORMAT:
					putURL(String(data));
					break;
				case ClipboardFormats.BITMAP_FORMAT:
					putBitmapData(data as BitmapData);
					break;
				case ClipboardFormats.FILE_LIST_FORMAT:
					nativePutFileList(data as Array);
					break;
				case ClipboardFormats.FILE_PROMISE_LIST_FORMAT:
					nativePutFilePromiseList(data as Array);
					break;
				default:
					// A script's own format: the object itself, and a serialized copy if it may be.
					putObjectReference(REFERENCE + format, data);
					if (serializable)
					{
						const bytes:ByteArray = new ByteArray();
						bytes.writeObject(data);
						putByteArray(SERIALIZATION + format, bytes);
					}
			}

			return true;
		}

		public function setDataHandler(format:String, handler:Function, serializable:Boolean = true):Boolean
		{
			checkWrite();
			setHandlerStoringData(serializable);
			nativeSetHandler(format, handler);
			return true;
		}

		public function getData(format:String, transferMode:String = "originalPreferred"):Object
		{
			if (!canReadContents)
			{
				throw new SecurityError("Reading from clipboard not permitted in this context");
			}

			switch (format)
			{
				case ClipboardFormats.TEXT_FORMAT:
					return getString();
				case ClipboardFormats.HTML_FORMAT:
					return getHTML();
				case ClipboardFormats.RICH_TEXT_FORMAT:
					return getRTF();
				case ClipboardFormats.URL_FORMAT:
					return getURL();
				case ClipboardFormats.BITMAP_FORMAT:
					return getBitmapData();
				case ClipboardFormats.FILE_LIST_FORMAT:
					return getFileList();
				case ClipboardFormats.FILE_PROMISE_LIST_FORMAT:
					return nativeGetFilePromiseList();
			}

			switch (transferMode)
			{
				case ClipboardTransferMode.ORIGINAL_ONLY:
					return getObjectReference(REFERENCE + format);
				case ClipboardTransferMode.CLONE_ONLY:
					return cloneOf(format);
				case ClipboardTransferMode.CLONE_PREFERRED:
					const clone:Object = cloneOf(format);
					return clone != null ? clone : getObjectReference(REFERENCE + format);
				default:
					const original:Object = getObjectReference(REFERENCE + format);
					return original != null ? original : cloneOf(format);
			}
		}

		public function hasFormat(format:String):Boolean
		{
			return canReadContents && formats.indexOf(format) >= 0;
		}

		// The player's keys for a script's own format, which formats gives back bare.
		private static const REFERENCE:String = "air:reference:";
		private static const SERIALIZATION:String = "air:serialization:";

		private function checkWrite():void
		{
			if (!canWriteContents)
			{
				throw new SecurityError("Writing to clipboard not permitted in this context");
			}
		}

		// A script's own format, as a copy read from what setData serialized.
		private function cloneOf(format:String):Object
		{
			const bytes:ByteArray = getByteArray(SERIALIZATION + format);
			return bytes != null ? bytes.readObject() : null;
		}

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
