// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/globalization/LocaleID.ts.

package flash.globalization
{
	[API("667")]
	public final class LocaleID
	{
		public function LocaleID(name:String)
		{
			ctor(name);
		}

		public static const DEFAULT:String = "i-default";

		public static native function determinePreferredLocales(want:Vector.<String>, have:Vector.<String>, keyword:String = "userinterface"):Vector.<String>;

		public native function getLanguage():String;

		public native function getRegion():String;

		public native function getScript():String;

		public native function getVariant():String;

		public native function get name():String;

		public native function getKeysAndValues():Object;

		public native function get lastOperationStatus():String;

		public native function isRightToLeft():Boolean;

		// The player's natives (packages/player/src/playerglobal/flash/globalization/LocaleID.ts).
		private native function ctor(name:String):void;
	}
}
