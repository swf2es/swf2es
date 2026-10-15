// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/media/VideoStreamSettings.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.media
{

	[API("674")]
	public class VideoStreamSettings
	{
		private var _bandwidth:int;
		private var _codec:String;
		private var _fps:Number;
		private var _height:int;
		private var _keyFrameInterval:int;
		private var _quality:int;
		private var _width:int;

		public function setKeyFrameInterval(keyFrameInterval:int):void
		{
		}

		public function setMode(width:int, height:int, fps:Number):void
		{
		}

		public function setQuality(bandwidth:int, quality:int):void
		{
		}

		public function get bandwidth():int
		{
			return this._bandwidth;
		}

		public function get codec():String
		{
			return this._codec;
		}

		public function get fps():Number
		{
			return this._fps;
		}

		public function get height():int
		{
			return this._height;
		}

		public function get keyFrameInterval():int
		{
			return this._keyFrameInterval;
		}

		public function get quality():int
		{
			return this._quality;
		}

		public function get width():int
		{
			return this._width;
		}
	}
}
