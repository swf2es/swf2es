// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	public class URLRequestDefaults
	{
		public function URLRequestDefaults()
		{
		}

		public static native function get followRedirects():Boolean;
		public static native function set followRedirects(value:Boolean):void;
		public static native function get manageCookies():Boolean;
		public static native function set manageCookies(value:Boolean):void;
		public static native function get authenticate():Boolean;
		public static native function set authenticate(value:Boolean):void;
		public static native function get useCache():Boolean;
		public static native function set useCache(value:Boolean):void;
		public static native function get cacheResponse():Boolean;
		public static native function set cacheResponse(value:Boolean):void;
		[API("668")]
		public static native function get idleTimeout():Number;
		[API("668")]
		public static native function set idleTimeout(value:Number):void;
		public static native function get userAgent():String;
		public static native function set userAgent(value:String):void;
		public static native function setLoginCredentialsForHost(hostname:String, user:String, password:String):*;
	}
}
