// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text.engine
{
	[API("662")]
	public final class SpaceJustifier extends TextJustifier
	{
		public function SpaceJustifier(locale:String = "en", lineJustification:String = "unjustified", letterSpacing:Boolean = false)
		{
			super(locale, lineJustification);
		}

		public native function get letterSpacing():Boolean;

		public native function set letterSpacing(value:Boolean):void;

		[API("667")]
		public native function get minimumSpacing():Number;

		[API("667")]
		public native function set minimumSpacing(value:Number):void;

		[API("667")]
		public native function get optimumSpacing():Number;

		[API("667")]
		public native function set optimumSpacing(value:Number):void;

		[API("667")]
		public native function get maximumSpacing():Number;

		[API("667")]
		public native function set maximumSpacing(value:Number):void;

		override public native function clone():TextJustifier;
	}
}
