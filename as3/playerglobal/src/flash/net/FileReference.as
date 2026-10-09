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
		public native function load():void;

		[API("662")]
		public native function save(data:*, defaultFileName:String = null):void;

		public native function get extension():String;

		public native function browse(typeFilter:Array = null):Boolean;

		[API("661")]
		public native function uploadUnencoded(request:URLRequest):void;

		// The player's natives (packages/player/src/playerglobal/flash/net/FileReference.ts).
		private native function _load(into:ByteArray):void;

		private native function _save(data:ByteArray, name:String):void;

		private static native function _ensureIsRootPlayer():void;
	}
}
