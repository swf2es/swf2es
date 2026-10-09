// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.utils
{
	import avmplus.getQualifiedClassName;

	public function getQualifiedClassName(value:*):String
	{
		return avmplus.getQualifiedClassName(value);
	}
}
