// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.filesystem
{
	import flash.events.EventDispatcher;

	public final class StorageVolumeInfo extends EventDispatcher
	{
		public function StorageVolumeInfo()
		{
		}

		public static native function get storageVolumeInfo():StorageVolumeInfo;
		[API("668")]
		public static native function get isSupported():Boolean;
		public native function getStorageVolumes():Vector.<StorageVolume>;
	}
}
