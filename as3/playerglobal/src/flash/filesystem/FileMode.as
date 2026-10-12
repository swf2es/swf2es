// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.filesystem
{
	[API("661")]
	public class FileMode
	{
		public function FileMode()
		{
		}

		public static const READ:String = "read";
		public static const WRITE:String = "write";
		public static const UPDATE:String = "update";
		public static const APPEND:String = "append";
	}
}
