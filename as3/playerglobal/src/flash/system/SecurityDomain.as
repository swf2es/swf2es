// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/system/SecurityDomain.ts.

package flash.system
{
	public class SecurityDomain
	{
		// Throws #2012: the player makes currentDomain without this.
		public function SecurityDomain()
		{
			ctor_impl();
		}

		public static native function get currentDomain():SecurityDomain;

		[API("680")]
		public native function get domainID():String;

		// The player's natives (packages/player/src/playerglobal/flash/system/SecurityDomain.ts).
		private native function ctor_impl():void;
	}
}
