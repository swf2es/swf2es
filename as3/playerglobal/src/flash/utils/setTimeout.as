// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.utils
{
	public function setTimeout(closure:Function, delay:Number, ...args):uint
	{
		return new IntervalTimer(closure, delay, false, args).id;
	}
}
