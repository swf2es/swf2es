// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.desktop
{
	import flash.events.EventDispatcher;
	import flash.utils.IDataInput;
	import flash.utils.IDataOutput;

	[API("668")]
	public class NativeProcess extends EventDispatcher
	{
		public function NativeProcess()
		{
		}

		public static native function get isSupported():Boolean;

		public native function closeInput():void;

		public native function get running():Boolean;

		public native function get standardError():IDataInput;

		public native function get standardInput():IDataOutput;

		public native function get standardOutput():IDataInput;

		public native function start(info:NativeProcessStartupInfo):void;

		public native function exit(arg0:Boolean = false):void;
	}
}
