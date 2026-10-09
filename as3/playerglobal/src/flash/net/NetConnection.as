// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/net/NetConnection.ts.

package flash.net
{
	import flash.events.EventDispatcher;

	public class NetConnection extends EventDispatcher
	{
		public function NetConnection()
		{
		}

		public static native function get defaultObjectEncoding():uint;
		public static native function set defaultObjectEncoding(arg0:uint):void;
		public native function get connected():Boolean;
		public native function get uri():String;
		public native function close():void;
		public native function addHeader(operation:String, mustUnderstand:Boolean = false, param:Object = null):void;
		public native function call(command:String, responder:Responder, ...arguments):void;
		public native function connect(command:String, ...arguments):void;
		public native function get client():Object;
		public native function set client(value:Object):void;
		public native function get objectEncoding():uint;
		public native function set objectEncoding(value:uint):void;
		public native function get proxyType():String;
		public native function set proxyType(value:String):void;
		public native function get connectedProxyType():String;
		public native function get usingTLS():Boolean;
		[API("662")]
		public native function get protocol():String;
		[API("662")]
		public native function get maxPeerConnections():uint;
		[API("662")]
		public native function set maxPeerConnections(value:uint):void;
		[API("662")]
		public native function get nearID():String;
		[API("662")]
		public native function get farID():String;
		[API("662")]
		public native function get nearNonce():String;
		[API("662")]
		public native function get farNonce():String;
		[API("662")]
		public native function get unconnectedPeerStreams():Array;
		[API("671")]
		public native function get httpIdleTimeout():Number;
		[API("671")]
		public native function set httpIdleTimeout(arg0:Number):void;
	}
}
