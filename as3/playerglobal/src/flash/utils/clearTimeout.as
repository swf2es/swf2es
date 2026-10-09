// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.utils
{
	public function clearTimeout(id:uint):void
	{
		IntervalTimer.clear(id);
	}
}
