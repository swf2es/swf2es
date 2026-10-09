// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).
// A URLStream's bytes, read whole once complete, as text, bytes or variables;
// the stream's events dispatched again from the loader.

package flash.net
{
	import flash.events.Event;
	import flash.events.EventDispatcher;
	import flash.events.HTTPStatusEvent;
	import flash.events.IOErrorEvent;
	import flash.events.ProgressEvent;
	import flash.events.SecurityErrorEvent;
	import flash.utils.ByteArray;

	public class URLLoader extends EventDispatcher
	{
		public var data:*;
		public var dataFormat:String = "text";
		public var bytesLoaded:uint = 0;
		public var bytesTotal:uint = 0;

		private var _stream:URLStream;

		public function URLLoader(request:URLRequest = null)
		{
			_stream = new URLStream();
			_stream.addEventListener(Event.OPEN, forward);
			_stream.addEventListener(ProgressEvent.PROGRESS, progress);
			_stream.addEventListener(HTTPStatusEvent.HTTP_STATUS, forward);
			_stream.addEventListener(HTTPStatusEvent.HTTP_RESPONSE_STATUS, forward);
			_stream.addEventListener(IOErrorEvent.IO_ERROR, failed);
			_stream.addEventListener(SecurityErrorEvent.SECURITY_ERROR, forward);
			_stream.addEventListener(Event.COMPLETE, complete);
			if (request != null)
			{
				load(request);
			}
		}

		override public function addEventListener(type:String, listener:Function, useCapture:Boolean = false, priority:int = 0, useWeakReference:Boolean = false):void
		{
			super.addEventListener(type, listener, useCapture, priority, useWeakReference);
		}

		public function load(request:URLRequest):void
		{
			bytesLoaded = 0;
			bytesTotal = 0;
			_stream.load(request);
		}

		public function close():void
		{
			if (_stream.connected)
			{
				_stream.close();
			}
		}

		private function forward(event:Event):void
		{
			dispatchEvent(event);
		}

		private function progress(event:ProgressEvent):void
		{
			bytesLoaded = event.bytesLoaded;
			bytesTotal = event.bytesTotal;
			dispatchEvent(event);
		}

		private function complete(event:Event):void
		{
			readData();
			dispatchEvent(event);
		}

		// A failed load's data is what it delivered, nothing, as Flash's reads after one.
		private function failed(event:IOErrorEvent):void
		{
			readData();
			dispatchEvent(event);
		}

		private function readData():void
		{
			const bytes:ByteArray = new ByteArray();
			if (_stream.connected)
			{
				_stream.readBytes(bytes);
			}

			switch (dataFormat)
			{
				case URLLoaderDataFormat.BINARY:
					data = bytes;
					break;
				case URLLoaderDataFormat.VARIABLES:
					data = new URLVariables(bytes.readUTFBytes(bytes.length));
					break;
				default:
					data = bytes.readUTFBytes(bytes.length);
			}
		}
	}
}
