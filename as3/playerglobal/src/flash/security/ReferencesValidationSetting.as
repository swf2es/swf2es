// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.security
{
	[API("663")]
	public final class ReferencesValidationSetting
	{
		public function ReferencesValidationSetting()
		{
		}

		public static const VALID_IDENTITY:String = "validIdentity";
		public static const VALID_OR_UNKNOWN_IDENTITY:String = "validOrUnknownIdentity";
		public static const NEVER:String = "never";
	}
}
