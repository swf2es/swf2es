// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.system
{
	import flash.events.EventDispatcher;
	import flash.utils.ByteArray;

	[API("682")]
	public final class AuthorizedFeaturesLoader extends EventDispatcher
	{
		public function AuthorizedFeaturesLoader()
		{
		}

		public native function get authorizedFeatures():AuthorizedFeatures;

		public native function loadAuthorizedFeatures():void;

		[API("688")]
		public native function loadAuthorizedFeaturesFromData(arg0:ByteArray):void;
	}
}
