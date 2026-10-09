// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/system/SecurityDomain.ts.

package flash.system
{
	public class SecurityDomain
	{
		public function SecurityDomain()
		{
		}

		public static native function get currentDomain():SecurityDomain;
		[API("680")]
		public native function get domainID():String;
	}
}
