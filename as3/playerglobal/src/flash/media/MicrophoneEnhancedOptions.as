// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/media/MicrophoneEnhancedOptions.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.media
{
	[API("672")]
	public final class MicrophoneEnhancedOptions
	{
		// Flash's defaults, and the values its setters take; others leave a field as it was.
		private var _echoPath:int = 128;

		public function get echoPath():int
		{
			return this._echoPath;
		}

		public function set echoPath(value:int):void
		{
			if (value == 128 || value == 256)
			{
				this._echoPath = value;
			}
		}
		private var _isVoiceDetected:int = -1;

		public function get isVoiceDetected():int
		{
			return this._isVoiceDetected;
		}

		public function set isVoiceDetected(value:int):*
		{
			this._isVoiceDetected = value;
		}
		private var _mode:String = MicrophoneEnhancedMode.FULL_DUPLEX;

		public function get mode():String
		{
			return this._mode;
		}

		public function set mode(value:String):void
		{
			switch (value)
			{
				case MicrophoneEnhancedMode.FULL_DUPLEX:
				case MicrophoneEnhancedMode.HALF_DUPLEX:
				case MicrophoneEnhancedMode.HEADSET:
				case MicrophoneEnhancedMode.SPEAKER_MUTE:
				case MicrophoneEnhancedMode.OFF:
					this._mode = value;
					break;
			}
		}
		private var _nonLinearProcessing:Boolean = true;

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
