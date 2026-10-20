// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).
// The player shares the native message broker with AVM1.

package flash.net
{
	import flash.events.EventDispatcher;

	public class LocalConnection extends EventDispatcher
	{
		public function LocalConnection()
		{
			ctor();
		}

		private native function ctor():void;

		[API("667")]
		public static function get isSupported():Boolean
		{
			return true;
		}

		public native function close():void;
		public native function connect(connectionName:String):void;
		public native function get domain():String;
		public native function send(connectionName:String, methodName:String, ...args):void;
		public native function get client():Object;
		public native function set client(client:Object):void;

		[API("665")]
		public native function get isPerUser():Boolean;

		[API("665")]
		public native function set isPerUser(value:Boolean):void;

		public native function allowDomain(...domains):void;
		public native function allowInsecureDomain(...domains):void;
	}
}
