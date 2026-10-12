// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.media
{
	import flash.filesystem.File;
	import flash.desktop.IFilePromise;
	import flash.events.ErrorEvent;
	import flash.events.EventDispatcher;
	import flash.utils.IDataInput;

	[API("669")]
	public class MediaPromise extends EventDispatcher implements IFilePromise
	{
		public function MediaPromise()
		{
		}

		public native function get isAsync():Boolean;

		public native function open():IDataInput;

		public native function close():void;

		public native function reportError(arg0:ErrorEvent):void;

		public native function get file():File;

		public native function get mediaType():String;

		public native function get relativePath():String;
	}
}
