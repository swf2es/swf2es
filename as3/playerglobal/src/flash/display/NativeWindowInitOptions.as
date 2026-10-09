// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	[API("661")]
	public class NativeWindowInitOptions
	{
		public function NativeWindowInitOptions()
		{
		}

		public native function get systemChrome():String;
		public native function set systemChrome(arg0:String):void;
		public native function get transparent():Boolean;
		public native function set transparent(arg0:Boolean):void;
		public native function get type():String;
		public native function set type(arg0:String):void;
		public native function get minimizable():Boolean;
		public native function set minimizable(arg0:Boolean):void;
		public native function get maximizable():Boolean;
		public native function set maximizable(arg0:Boolean):void;
		public native function get resizable():Boolean;
		public native function set resizable(arg0:Boolean):void;
		[API("671")]
		public native function get owner():NativeWindow;
		[API("671")]
		public native function set owner(arg0:NativeWindow):void;
		[API("675")]
		public native function get renderMode():String;
		[API("675")]
		public native function set renderMode(arg0:String):void;
	}
}
