// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	public class Responder
	{
		public function Responder(result:Function, status:Function = null)
		{
			ctor(result, status);
		}

		// The player's natives (packages/player/src/playerglobal/flash/net/Responder.ts).
		private native function ctor(result:Function, status:Function):void;
	}
}
