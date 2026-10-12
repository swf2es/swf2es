// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/system/IME.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.system
{

	import flash.events.EventDispatcher;

	public final class IME extends EventDispatcher
	{
		private static var _conversionMode:String = "ALPHANUMERIC_HALF";
		private static var _enabled:Boolean;

		public static function compositionAbandoned():void
		{
		}

		public static function compositionSelectionChanged(start:int, end:int):void
		{
		}

		public static function doConversion():void
		{
		}

		public static function setCompositionString(composition:String):void
		{
		}

		[API("667")]
		public static function get isSupported():Boolean
		{
			return false;
		}

		public static function get enabled():Boolean
		{
			return _enabled;
		}

		public static function set enabled(value:Boolean):void
		{
			_enabled = value;
		}

		public static function get conversionMode():String
		{
			return _conversionMode;
		}

		public static function set conversionMode(value:String):void
		{
			_conversionMode = value;
		}
	}
}
