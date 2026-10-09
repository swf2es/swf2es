// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.html
{
	[API("661")]
	public class HTMLHistoryItem
	{
		public function HTMLHistoryItem(arg0:String, arg1:String, arg2:Boolean, arg3:String)
		{
		}

		public native function get url():String;
		public native function get originalUrl():String;
		public native function get isPost():Boolean;
		public native function get title():String;
	}
}
