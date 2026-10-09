// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.events.EventDispatcher;

	public class XMLSocket extends EventDispatcher
	{
		public function XMLSocket(host:String = null, port:int = 0)
		{
		}

		public native function connect(host:String, port:int):void;

		public native function send(object:*):void;

		[API("662")]
		public native function get timeout():int;

		[API("662")]
		public native function set timeout(value:int):void;

		public native function close():void;

		public native function get connected():Boolean;
	}
}
