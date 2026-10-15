// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.filesystem
{
	[API("668")]
	public class StorageVolume
	{
		public function StorageVolume(arg0:File, arg1:String, arg2:Boolean, arg3:Boolean, arg4:String, arg5:String)
		{
		}

		public native function get rootDirectory():File;

		public native function get name():String;

		public native function get drive():String;

		public native function get isWritable():Boolean;

		public native function get isRemovable():Boolean;

		public native function get fileSystemType():String;
	}
}
