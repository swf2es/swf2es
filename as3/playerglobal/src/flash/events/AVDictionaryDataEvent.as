// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.events
{
	import flash.utils.Dictionary;

	[API("692")]
	public class AVDictionaryDataEvent extends Event
	{
		public static const AV_DICTIONARY_DATA:String = "avDictionaryData";

		private var _dictionary:Dictionary;
		private var _time:Number;

		public function AVDictionaryDataEvent(type:String = "avDictionaryData", bubbles:Boolean = false, cancelable:Boolean = false, dictionary:Dictionary = null, time:Number = 0)
		{
			super(type, bubbles, cancelable);
			_dictionary = dictionary;
			_time = time;
		}

		public function get dictionary():Dictionary
		{
			return _dictionary;
		}

		public function get time():Number
		{
			return _time;
		}
	}
}
