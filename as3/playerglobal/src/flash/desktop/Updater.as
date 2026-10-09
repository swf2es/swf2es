// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.desktop
{
	import flash.filesystem.File;

	public final class Updater
	{
		public function Updater()
		{
		}

		[API("668")]
		public static native function get isSupported():Boolean;
		public native function update(arg0:File, arg1:String):void;
	}
}
