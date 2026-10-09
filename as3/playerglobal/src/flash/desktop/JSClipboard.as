// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.desktop
{
	[API("661")]
	public class JSClipboard
	{
		public function JSClipboard(arg0:Boolean, arg1:Boolean, arg2:Clipboard = null, arg3:NativeDragOptions = null)
		{
		}

		public static native function urisFromURIList(arg0:String):Array;

		public native function get dropEffect():String;

		public native function set dropEffect(arg0:String):void;

		public native function get effectAllowed():String;

		public native function set effectAllowed(arg0:String):void;

		public native function get propagationStopped():Boolean;

		public native function set propagationStopped(arg0:Boolean):void;

		public native function getData(arg0:String):Object;

		public native function setData(arg0:String, arg1:Object):Boolean;

		public native function clearData(arg0:String):void;

		public native function clearAllData():void;

		public native function get types():Array;

		public native function get dragOptions():NativeDragOptions;

		public native function set dragOptions(arg0:NativeDragOptions):void;

		public native function get clipboard():Clipboard;
	}
}
