// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// its body AS3's: the event and the Files it carries.

package flash.events
{
	[API("661")]
	public class FileListEvent extends Event
	{
		public static const DIRECTORY_LISTING:String = "directoryListing";
		public static const SELECT_MULTIPLE:String = "selectMultiple";

		public var files:Array;

		public function FileListEvent(type:String, bubbles:Boolean = false, cancelable:Boolean = false, files:Array = null)
		{
			super(type, bubbles, cancelable);
			this.files = files;
		}
	}
}
