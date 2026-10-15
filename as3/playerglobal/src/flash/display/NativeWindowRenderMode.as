// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	[API("675")]
	public final class NativeWindowRenderMode
	{
		public function NativeWindowRenderMode()
		{
		}

		public static const AUTO:String = "auto";
		public static const CPU:String = "cpu";
		public static const DIRECT:String = "direct";
		public static const GPU:String = "gpu";
	}
}
