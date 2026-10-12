// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.data
{
	import flash.events.EventDispatcher;
	import flash.net.Responder;
	import flash.utils.ByteArray;

	[API("661")]
	public class SQLConnection extends EventDispatcher
	{
		public function SQLConnection()
		{
		}

		[API("683")]
		public static native function get isSupported():Boolean;

		public native function get autoCompact():Boolean;

		public native function get connected():Boolean;

		public native function get cacheSize():uint;

		public native function set cacheSize(arg0:uint):void;

		public native function get columnNameStyle():String;

		public native function set columnNameStyle(arg0:String):void;

		public native function get inTransaction():Boolean;

		public native function get lastInsertRowID():Number;

		public native function get pageSize():uint;

		public native function get totalChanges():Number;

		override public native function addEventListener(arg0:String, arg1:Function, arg2:Boolean = false, arg3:int = 0, arg4:Boolean = false):void;

		public native function analyze(arg0:String = null, arg1:Responder = null):void;

		public native function attach(arg0:String, arg1:Object = null, arg2:Responder = null, arg3:ByteArray = null):void;

		public native function begin(arg0:String = null, arg1:Responder = null):void;

		public native function cancel(arg0:Responder = null):void;

		public native function commit(arg0:Responder = null):void;

		public native function compact(arg0:Responder = null):void;

		public native function close(arg0:Responder = null):void;

		public native function deanalyze(arg0:Responder = null):void;

		public native function detach(arg0:String, arg1:Responder = null):void;

		public native function getSchemaResult():SQLSchemaResult;

		public native function loadSchema(arg0:Class = null, arg1:String = null, arg2:String = "main", arg3:Boolean = true, arg4:Responder = null):void;

		public native function open(arg0:Object = null, arg1:String = "create", arg2:Boolean = false, arg3:int = 1024, arg4:ByteArray = null):void;

		public native function openAsync(arg0:Object = null, arg1:String = "create", arg2:Responder = null, arg3:Boolean = false, arg4:int = 1024, arg5:ByteArray = null):void;

		[API("663")]
		public native function reencrypt(arg0:ByteArray, arg1:Responder = null):void;

		[API("668")]
		public native function releaseSavepoint(arg0:String = null, arg1:Responder = null):void;

		override public native function removeEventListener(arg0:String, arg1:Function, arg2:Boolean = false):void;

		public native function rollback(arg0:Responder = null):void;

		[API("668")]
		public native function rollbackToSavepoint(arg0:String = null, arg1:Responder = null):void;

		[API("668")]
		public native function setSavepoint(arg0:String = null, arg1:Responder = null):void;
	}
}
