// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/media/SoundLoaderContext.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.media
{
	public class SoundLoaderContext
	{
		public var bufferTime:Number = 1000;
		public var checkPolicyFile:Boolean = false;

		public function SoundLoaderContext(bufferTime:Number = 1000, checkPolicyFile:Boolean = false)
		{
			this.checkPolicyFile = checkPolicyFile;
			this.bufferTime = bufferTime;
		}
	}
}
