// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/globalization/DateTimeFormatter.ts.

package flash.globalization
{
	[API("667")]
	public final class DateTimeFormatter
	{
		public function DateTimeFormatter(requestedLocaleIDName:String, dateStyle:String = "long", timeStyle:String = "long")
		{
			ctor(requestedLocaleIDName, dateStyle, timeStyle);
		}

		public static native function getAvailableLocaleIDNames():Vector.<String>;

		public native function setDateTimeStyles(dateStyle:String, timeStyle:String):void;

		public native function getTimeStyle():String;

		public native function getDateStyle():String;

		public native function get lastOperationStatus():String;

		public native function get requestedLocaleIDName():String;

		public native function get actualLocaleIDName():String;

		public native function format(dateTime:Date):String;

		public native function formatUTC(dateTime:Date):String;

		public native function getMonthNames(nameStyle:String = "full", context:String = "standalone"):Vector.<String>;

		public native function getWeekdayNames(nameStyle:String = "full", context:String = "standalone"):Vector.<String>;

		public native function getFirstWeekday():int;

		public native function getDateTimePattern():String;

		public native function setDateTimePattern(pattern:String):void;

		// The player's natives (packages/player/src/playerglobal/flash/globalization/DateTimeFormatter.ts).
		private native function ctor(requestedLocaleIDName:String, dateStyle:String, timeStyle:String):void;

		private native function formatImplementation(date:Date, utc:Boolean):String;
	}
}
