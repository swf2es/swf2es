// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.security
{
	public final class RevocationCheckSettings
	{
		public function RevocationCheckSettings()
		{
		}

		public static const NEVER:String = "never";
		public static const BEST_EFFORT:String = "bestEffort";
		public static const REQUIRED_IF_AVAILABLE:String = "requiredIfInfoAvailable";
		public static const ALWAYS_REQUIRED:String = "alwaysRequired";
	}
}
