// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.system
{
	import flash.utils.ByteArray;

	[API("680")]
	public final class WorkerDomain
	{
		private static var _current:WorkerDomain;

		public function WorkerDomain()
		{
		}

		public static native function get isSupported():Boolean;

		public static function get current():WorkerDomain
		{
			if (_current == null)
			{
				_current = new WorkerDomain();
			}

			return _current;
		}

		public native function createWorker(swf:ByteArray, giveAppPrivileges:Boolean = false):Worker;

		public native function listWorkers():Vector.<Worker>;
	}
}
