// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.html
{
	public final class HTMLPDFCapability
	{
		public function HTMLPDFCapability()
		{
		}

		public static const STATUS_OK:int = 0;
		public static const ERROR_INSTALLED_READER_NOT_FOUND:int = 3201;
		public static const ERROR_INSTALLED_READER_TOO_OLD:int = 3202;
		public static const ERROR_PREFERRED_READER_TOO_OLD:int = 3203;
		public static const ERROR_CANNOT_LOAD_READER:int = 3204;
	}
}
