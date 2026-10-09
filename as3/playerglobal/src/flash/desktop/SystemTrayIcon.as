// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.desktop
{
	import flash.display.NativeMenu;

	[API("661")]
	public class SystemTrayIcon extends InteractiveIcon
	{
		public function SystemTrayIcon()
		{
		}

		public static const MAX_TIP_LENGTH:Number = 63;

		override public native function set bitmaps(arg0:Array):void;

		override public native function get bitmaps():Array;

		override public native function get width():int;

		override public native function get height():int;

		public native function get tooltip():String;

		public native function set tooltip(arg0:String):void;

		public native function get menu():NativeMenu;

		public native function set menu(arg0:NativeMenu):void;
	}
}
