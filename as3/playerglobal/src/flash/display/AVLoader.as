// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.display
{
	import flash.net.URLRequest;
	import flash.system.LoaderContext;

	[API("688")]
	public class AVLoader extends Loader
	{
		public function AVLoader()
		{
			super();
		}

		// An override, as Flash Player's is, that loads as Loader does.
		override public function load(request:URLRequest, context:LoaderContext = null):void
		{
			super.load(request, context);
		}
	}
}
