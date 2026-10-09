// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.utils
{
	import avmplus.getQualifiedSuperclassName;

	public function getQualifiedSuperclassName(value:*):String
	{
		return avmplus.getQualifiedSuperclassName(value);
	}
}
