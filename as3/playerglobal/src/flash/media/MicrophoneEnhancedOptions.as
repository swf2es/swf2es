// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/media/MicrophoneEnhancedOptions.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.media
{
	[API("672")]
	public final class MicrophoneEnhancedOptions
	{
		private var _echoPath:int;

		public function get echoPath():int
		{
			return this._echoPath;
		}

		public function set echoPath(value:int):void
		{
			this._echoPath = value;
		}
		private var _isVoiceDetected:int;

		public function get isVoiceDetected():int
		{
			return this._isVoiceDetected;
		}

		public function set isVoiceDetected(value:int):*
		{
			this._isVoiceDetected = value;
		}
		private var _mode:String;

		public function get mode():String
		{
			return this._mode;
		}

		public function set mode(value:String):void
		{
			this._mode = value;
		}
		private var _nonLinearProcessing:Boolean;

		public function get nonLinearProcessing():Boolean
		{
			return this._nonLinearProcessing;
		}

		public function set nonLinearProcessing(value:Boolean):void
		{
			this._nonLinearProcessing = value;
		}

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		public native function get autoGain():Boolean;
		public native function set autoGain(arg0:Boolean):void;
	}
}
