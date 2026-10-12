// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.utils
{
	public function setInterval(closure:Function, delay:Number, ...args):uint
	{
		return new IntervalTimer(closure, delay, true, args).id;
	}
}
