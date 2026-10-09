// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.data
{
	import flash.events.EventDispatcher;
	import flash.net.Responder;

	[API("661")]
	public class SQLStatement extends EventDispatcher
	{
		public function SQLStatement()
		{
		}

		public native function get executing():Boolean;
		public native function get sqlConnection():SQLConnection;
		public native function set sqlConnection(arg0:SQLConnection):void;
		public native function get itemClass():Class;
		public native function set itemClass(arg0:Class):void;
		public native function get parameters():Object;
		public native function get text():String;
		public native function set text(arg0:String):void;
		public native function cancel():void;
		public native function clearParameters():void;
		public native function execute(arg0:int = -1, arg1:Responder = null):void;
		public native function getResult():SQLResult;
		public native function next(arg0:int = -1, arg1:Responder = null):void;
	}
}
