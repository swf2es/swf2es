// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.events
{
	public class AVHTTPStatusEvent extends Event
	{
		public static const AV_HTTP_RESPONSE_STATUS:String = "avHttpResponseStatus";

		private var _status:int;
		private var _responseURL:String;
		private var _responseHeaders:Array;

		public function AVHTTPStatusEvent(type:String, bubbles:Boolean = false, cancelable:Boolean = false, status:int = 0, responseURL:String = null, responseHeaders:Array = null)
		{
			super(type, bubbles, cancelable);
			_status = status;
			_responseURL = responseURL;
			_responseHeaders = responseHeaders;
		}

		override public function clone():Event
		{
			return new AVHTTPStatusEvent(type, bubbles, cancelable, _status, _responseURL, _responseHeaders);
		}

		override public function toString():String
		{
			return formatToString("AVHTTPStatusEvent", "type", "bubbles", "cancelable", "eventPhase", "status", "responseURL", "responseHeaders");
		}

		public function get status():int
		{
			return _status;
		}

		public function get responseURL():String
		{
			return _responseURL;
		}

		public function set responseURL(value:String):void
		{
			_responseURL = value;
		}

		public function get responseHeaders():Array
		{
			return _responseHeaders;
		}

		public function set responseHeaders(value:Array):void
		{
			_responseHeaders = value;
		}
	}
}
