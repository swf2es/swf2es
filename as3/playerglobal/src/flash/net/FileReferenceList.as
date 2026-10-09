// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.events.EventDispatcher;

	public class FileReferenceList extends EventDispatcher
	{
		public function FileReferenceList()
		{
		}

		public native function get fileList():Array;

		public native function browse(typeFilter:Array = null):Boolean;
	}
}
