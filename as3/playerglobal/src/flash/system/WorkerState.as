// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/system/WorkerState.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.system
{
	[API("682")]
	public final class WorkerState
	{
		public static const NEW:String = "new";
		public static const RUNNING:String = "running";
		public static const TERMINATED:String = "terminated";
	}
}
