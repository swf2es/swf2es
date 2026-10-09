// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.desktop
{
	public final class InvokeEventReason
	{
		public function InvokeEventReason()
		{
		}

		public static const LOGIN:String = "login";
		[API("685")]
		public static const NOTIFICATION:String = "notification";
		[API("685")]
		public static const OPEN_URL:String = "openUrl";
		public static const STANDARD:String = "standard";
	}
}
