// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/net/URLRequest.ts.

package flash.net
{
	public final class URLRequest
	{
		public function URLRequest(url:String = null)
		{
		}

		public native function get url():String;
		public native function set url(url:String):void;
		public native function get data():Object;
		public native function set data(newData:Object):void;
		public native function get method():String;
		public native function set method(value:String):void;
		public native function get contentType():String;
		public native function set contentType(value:String):void;
		public native function get requestHeaders():Array;
		public native function set requestHeaders(headers:Array):void;
		public native function get digest():String;
		public native function set digest(value:String):void;
		[API("690")]
		public native function useRedirectedURL(arg0:URLRequest, arg1:Boolean = false, arg2:* = null, arg3:String = null):void;
		[API("661")]
		public native function get followRedirects():Boolean;
		[API("661")]
		public native function set followRedirects(arg0:Boolean):void;
		[API("661")]
		public native function get userAgent():String;
		[API("661")]
		public native function set userAgent(arg0:String):void;
		[API("661")]
		public native function get manageCookies():Boolean;
		[API("661")]
		public native function set manageCookies(arg0:Boolean):void;
		[API("661")]
		public native function get useCache():Boolean;
		[API("661")]
		public native function set useCache(arg0:Boolean):void;
		[API("661")]
		public native function get cacheResponse():Boolean;
		[API("661")]
		public native function set cacheResponse(arg0:Boolean):void;
		[API("668")]
		public native function get idleTimeout():Number;
		[API("668")]
		public native function set idleTimeout(arg0:Number):void;
		[API("661")]
		public native function get authenticate():Boolean;
		[API("661")]
		public native function set authenticate(arg0:Boolean):void;
	}
}
