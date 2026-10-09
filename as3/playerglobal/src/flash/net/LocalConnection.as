// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.events.EventDispatcher;

	public class LocalConnection extends EventDispatcher
	{
		public function LocalConnection()
		{
		}

		[API("667")]
		public static native function get isSupported():Boolean;
		public native function close():void;
		public native function connect(connectionName:String):void;
		public native function get domain():String;
		public native function send(connectionName:String, methodName:String, ...arguments):void;
		public native function get client():Object;
		public native function set client(client:Object):void;
		[API("665")]
		public native function get isPerUser():Boolean;
		[API("665")]
		public native function set isPerUser(arg0:Boolean):void;
		public native function allowDomain(...domains):void;
		public native function allowInsecureDomain(...domains):void;
	}
}
