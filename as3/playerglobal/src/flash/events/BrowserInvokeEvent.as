// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("661")]
	public class BrowserInvokeEvent extends Event
	{
		public function BrowserInvokeEvent(arg0:String, arg1:Boolean, arg2:Boolean, arg3:Array, arg4:String, arg5:String, arg6:Boolean, arg7:Boolean)
		{
			super(arg0);
		}

		public static const BROWSER_INVOKE:String = "browserInvoke";
		override public native function clone():Event;
		public native function get arguments():Array;
		public native function get sandboxType():String;
		public native function get securityDomain():String;
		public native function get isHTTPS():Boolean;
		public native function get isUserEvent():Boolean;
	}
}
