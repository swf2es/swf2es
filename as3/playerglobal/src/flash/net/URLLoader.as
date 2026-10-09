// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.events.EventDispatcher;

	public class URLLoader extends EventDispatcher
	{
		public function URLLoader(request:URLRequest = null)
		{
		}

		public var data:*;
		public var dataFormat:String = "text";
		public var bytesLoaded:uint = 0;
		public var bytesTotal:uint = 0;

		override public native function addEventListener(arg0:String, arg1:Function, arg2:Boolean = false, arg3:int = 0, arg4:Boolean = false):void;

		public native function load(request:URLRequest):void;

		public native function close():void;
	}
}
