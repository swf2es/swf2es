// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.desktop
{
	import flash.display.NativeMenu;

	[API("661")]
	public class DockIcon extends InteractiveIcon
	{
		public function DockIcon()
		{
		}

		override public native function set bitmaps(arg0:Array):void;
		override public native function get bitmaps():Array;
		override public native function get width():int;
		override public native function get height():int;
		public native function get menu():NativeMenu;
		public native function set menu(arg0:NativeMenu):void;
		public native function bounce(arg0:String = "informational"):void;
	}
}
