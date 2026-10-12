// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/crypto/generateRandomBytes.ts.

package flash.crypto
{
	import flash.utils.ByteArray;

	[API("674")]
	public native function generateRandomBytes(arg0:uint):ByteArray;
}
