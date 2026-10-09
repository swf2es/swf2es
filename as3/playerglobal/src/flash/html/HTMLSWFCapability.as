// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.html
{
	[API("668")]
	public final class HTMLSWFCapability
	{
		public function HTMLSWFCapability()
		{
		}

		public static const STATUS_OK:int = 0;
		public static const ERROR_INSTALLED_PLAYER_NOT_FOUND:int = 3221;
		public static const ERROR_INSTALLED_PLAYER_TOO_OLD:int = 3222;
	}
}
