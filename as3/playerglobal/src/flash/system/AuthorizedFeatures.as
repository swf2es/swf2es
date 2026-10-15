// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.system
{
	import flash.net.URLStream;
	import flash.utils.ByteArray;

	[API("682")]
	public final class AuthorizedFeatures
	{
		public function AuthorizedFeatures()
		{
		}

		public native function createApplicationInstaller(arg0:XML, arg1:ByteArray):ApplicationInstaller;

		public native function enableDiskCache(arg0:URLStream):Boolean;
	}
}
