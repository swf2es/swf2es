// The AS3 host of tests/unit/player/scripting/avm1-movie.test.ts: it loads
// movie.swf, an AVM1 SWF (tests/avm1-lifecycle.ts), by URL or from its
// bytes, and does what the test asks through control(), at once or,
// through later(), in its next ENTER_FRAME or EXIT_FRAME, commands parted
// by ";". Its lines start "as3:".
package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.media.Sound;
	import flash.media.SoundChannel;
	import flash.media.SoundMixer;
	import flash.media.SoundTransform;
	import flash.net.LocalConnection;
	import flash.net.SharedObject;
	import flash.net.URLLoader;
	import flash.net.URLLoaderDataFormat;
	import flash.net.URLRequest;
	import flash.system.LoaderContext;
	import flash.utils.ByteArray;

	public class LoadedAvm1Lifecycle extends Sprite
	{
		private var loader:Loader = new Loader();
		private var channel:SoundChannel;
		private var last:Number = -1;
		private var phase:String = null;
		private var pending:String = null;
		private var connection:LocalConnection;

		public function LoadedAvm1Lifecycle()
		{
			addChild(loader);
			addEventListener(Event.ENTER_FRAME, function(e:Event):void
				{
					act(Event.ENTER_FRAME);
				});
			addEventListener(Event.EXIT_FRAME, function(e:Event):void
				{
					act(Event.EXIT_FRAME);
				});
		}

		private function log(s:String):void
		{
			trace("as3:" + s);
		}

		private function act(type:String):void
		{
			if (pending !== null && phase == type)
			{
				var commands:Array = pending.split(";");
				pending = null;
				for each (var command:String in commands)
				{
					control(command);
				}
			}
		}

		/** `command` in the next event of `type`, enterFrame or exitFrame. */
		public function later(type:String, command:String):void
		{
			phase = type;
			pending = command;
		}

		private function data(o:SharedObject):String
		{
			var r:String = "";
			for (var k:String in o.data)
			{
				r += k + "=" + o.data[k] + ";";
			}

			return r;
		}

		public function control(command:String):void
		{
			var words:Array = command.split(" ");
			switch (words[0])
			{
				case "load":
					loader.load(new URLRequest("movie.swf"));
					break;
				case "bytes":
					var request:URLLoader = new URLLoader();
					request.dataFormat = URLLoaderDataFormat.BINARY;
					request.addEventListener(Event.COMPLETE, function(e:Event):void
						{
							var context:LoaderContext = new LoaderContext();
							context.allowCodeImport = true;
							loader.loadBytes(request.data, context);
						});
					request.load(new URLRequest("movie.swf"));
					break;
				case "remove":
					removeChild(loader);
					break;
				case "add":
					addChild(loader);
					break;
				case "mixer":
					var t:SoundTransform = SoundMixer.soundTransform;
					log("mixer " + t.volume + " " + t.leftToLeft + " " + t.leftToRight + " " + t.rightToLeft + " " + t.rightToRight);
					break;
				case "setMixer":
					SoundMixer.soundTransform = new SoundTransform(Number(words[1]), Number(words[2]));
					break;
				case "stopAll":
					SoundMixer.stopAll();
					break;
				case "play":
					// A second of quiet, looped: whether a channel is free for it.
					var samples:ByteArray = new ByteArray();
					for (var i:int = 0; i < 4410; i++)
					{
						samples.writeFloat(0);
						samples.writeFloat(0);
					}

					samples.position = 0;
					var sound:Sound = new Sound();
					sound.loadPCMFromByteArray(samples, 4410);
					channel = sound.play(0, 1000);
					last = -1;
					log("play " + (channel ? "channel" : "null"));
					break;
				case "position":
					var p:Number = channel.position;
					log("position " + (p > last ? "on" : "stopped"));
					last = p;
					break;
				case "unload":
					loader.unload();
					log("unload");
					break;
				case "unloadAndStop":
					loader.unloadAndStop();
					log("unloadAndStop");
					break;
				case "connect":
					connection = new LocalConnection();
					try
					{
						connection.connect(words[1]);
						log("connect " + words[1]);
					}
					catch (e:Error)
					{
						log("connect " + words[1] + " " + e.errorID);
					}

					break;
				case "stage":
					log("stage " + stage.stageWidth + "x" + stage.stageHeight + " " + stage.scaleMode + " " + stage.align + " " + stage.showDefaultContextMenu + " " + stage.quality);
					break;
				case "quality":
					stage.quality = words[1];
					break;
				case "scaleMode":
					stage.scaleMode = words[1];
					break;
				case "url":
					log("url " + loaderInfo.url + " " + loader.contentLoaderInfo.url);
					break;
				case "shared":
					var so:SharedObject = words.length > 2 ? SharedObject.getLocal(words[1], words[2]) : SharedObject.getLocal(words[1]);
					log("shared " + words[1] + " " + data(so));
					break;
			}
		}
	}
}
