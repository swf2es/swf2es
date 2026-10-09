// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/text/engine/TabStop.ts.

package flash.text.engine
{
	[API("662")]
	public final class TabStop
	{
		public function TabStop(alignment:String = "start", position:Number = 0, decimalAlignmentToken:String = "")
		{
		}

		public native function get alignment():String;
		public native function set alignment(value:String):void;
		public native function get position():Number;
		public native function set position(value:Number):void;
		public native function get decimalAlignmentToken():String;
		public native function set decimalAlignmentToken(value:String):void;
	}
}
