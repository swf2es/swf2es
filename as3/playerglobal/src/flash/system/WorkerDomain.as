// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.system
{
	import flash.utils.ByteArray;

	[API("680")]
	public final class WorkerDomain
	{
		public function WorkerDomain()
		{
		}

		public static native function get isSupported():Boolean;
		public static native function get current():WorkerDomain;
		public native function createWorker(swf:ByteArray, giveAppPrivileges:Boolean = false):Worker;
		public native function listWorkers():Vector.<Worker>;
	}
}
