// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/Scene.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	public final class Scene
	{
		private var _name:String;
		private var _labels:Array;
		private var _numFrames:int;

		public function Scene(name:String, labels:Array, numFrames:int)
		{
			this._name = name;
			this._labels = labels;
			this._numFrames = numFrames;
		}

		public function get name():String
		{
			return this._name;
		}

		public function get labels():Array
		{
			return this._labels;
		}

		public function get numFrames():int
		{
			return this._numFrames;
		}
	}
}
