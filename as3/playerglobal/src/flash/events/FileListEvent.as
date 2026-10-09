// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("661")]
	public class FileListEvent extends Event
	{
		public function FileListEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:Array = null)
		{
			super(arg0);
		}

		public static const DIRECTORY_LISTING:String = "directoryListing";
		public static const SELECT_MULTIPLE:String = "selectMultiple";
		public var files:Array;
	}
}
