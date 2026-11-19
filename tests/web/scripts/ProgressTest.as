package {
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.IEventDispatcher;
	import flash.events.IOErrorEvent;
	import flash.events.ProgressEvent;
	import flash.media.Sound;
	import flash.net.URLLoader;
	import flash.net.URLLoaderDataFormat;
	import flash.net.URLRequest;
	import flash.net.URLStream;

	// Loads, one after another, from a server that sends each a piece at a time: a Loader's SWF,
	// a URLLoader's and a URLStream's data, with and without a length, and a Sound's MP3. Each
	// tells its progress as it goes, a URLStream what it can read then.
	public class ProgressTest extends Sprite {
		private var base:String;
		private var jobs:Array = [
			["loader", "/swf"],
			["urlloader", "/bin"],
			["urlstream", "/bin"],
			["unsized", "/bin?unsized"],
			["sound", "/mp3"]
		];
		private var kept:Array = [];

		public function ProgressTest() {
			base = loaderInfo.parameters.base;
			next();
		}

		private function next():void {
			if (jobs.length == 0) {
				trace("progress: done");
				return;
			}

			var job:Array = jobs.shift();
			var kind:String = job[0];
			var request:URLRequest = new URLRequest(base + job[1]);
			var target:IEventDispatcher;
			var stream:URLStream = null;
			if (kind == "loader") {
				var loader:Loader = new Loader();
				target = loader.contentLoaderInfo;
				loader.load(request);
				kept.push(loader);
			} else if (kind == "urlloader") {
				var urlLoader:URLLoader = new URLLoader();
				urlLoader.dataFormat = URLLoaderDataFormat.BINARY;
				target = urlLoader;
				urlLoader.load(request);
			} else if (kind == "sound") {
				var sound:Sound = new Sound();
				target = sound;
				sound.load(request);
			} else {
				stream = new URLStream();
				target = stream;
				stream.load(request);
			}

			kept.push(target);
			target.addEventListener(ProgressEvent.PROGRESS, function(e:ProgressEvent):void {
				trace("progress: " + kind + " progress " + e.bytesLoaded + " " + e.bytesTotal
					+ (stream ? " " + stream.bytesAvailable : ""));
			});
			target.addEventListener(Event.COMPLETE, function(e:Event):void {
				trace("progress: " + kind + " complete");
				next();
			});
			target.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void {
				trace("progress: " + kind + " ioError " + e.text);
				next();
			});
		}
	}
}
