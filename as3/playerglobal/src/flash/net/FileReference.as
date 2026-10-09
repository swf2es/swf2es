// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/net/FileReference.ts.

package flash.net
{
	import flash.events.EventDispatcher;
	import flash.utils.ByteArray;

	public class FileReference extends EventDispatcher
	{
		public function FileReference()
		{
		}

		public native function get creationDate():Date;

		public native function get creator():String;

		public native function get modificationDate():Date;

		public native function get name():String;

		public native function get size():Number;

		public native function get type():String;

		public native function cancel():void;

		public native function download(request:URLRequest, defaultFileName:String = null):void;

		public native function upload(request:URLRequest, uploadDataFieldName:String = "Filedata", testUpload:Boolean = false):void;

		[API("662")]
		public native function get data():ByteArray;

		[API("662")]
		public function load():void
		{
			_load(new ByteArray());
		}

		[API("662")]
		public function save(data:*, defaultFileName:String = null):void
		{
			// Bytes as they are, anything else as its text in UTF-8.
			var bytes:ByteArray = data as ByteArray;
			if (bytes == null)
			{
				bytes = new ByteArray();
				bytes.writeUTFBytes(String(data));
			}

			_save(bytes, defaultFileName);
		}

		public function get extension():String
		{
			// The name throws where there is no file, as Flash's does.
			const fileName:String = name;
			const dot:int = fileName.lastIndexOf(".");
			return dot >= 0 ? fileName.substr(dot + 1) : null;
		}

		public native function browse(typeFilter:Array = null):Boolean;

		[API("661")]
		public native function uploadUnencoded(request:URLRequest):void;

		// The player's natives (packages/player/src/playerglobal/flash/net/FileReference.ts).
		private native function _load(into:ByteArray):void;

		private native function _save(data:ByteArray, name:String):void;

		private static native function _ensureIsRootPlayer():void;
	}
}
