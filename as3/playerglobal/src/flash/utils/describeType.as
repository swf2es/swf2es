// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.utils
{
	import avmplus.FLASH10_FLAGS;
	import avmplus.describeType;

	// avmplus' describeType, with the flags Flash Player 10 and later describe by.
	public function describeType(value:*):XML
	{
		return avmplus.describeType(value, avmplus.FLASH10_FLAGS);
	}
}
