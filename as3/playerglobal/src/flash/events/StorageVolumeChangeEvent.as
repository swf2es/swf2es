// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	import flash.filesystem.File;
	import flash.filesystem.StorageVolume;

	[API("668")]
	public class StorageVolumeChangeEvent extends Event
	{
		public function StorageVolumeChangeEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:File = null, arg4:StorageVolume = null)
		{
			super(arg0);
		}

		public static const STORAGE_VOLUME_MOUNT:String = "storageVolumeMount";
		public static const STORAGE_VOLUME_UNMOUNT:String = "storageVolumeUnmount";

		override public native function clone():Event;

		override public native function toString():String;

		public native function get rootDirectory():File;

		public native function get storageVolume():StorageVolume;
	}
}
