// Which loads take an instance name: Loader.load and loadBytes each take
// one in the call, the name a SWF's root, AS3's or AVM1's, gets as it
// comes, a load that fails or is replaced leaving its own unused.
package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.net.URLLoader;
	import flash.net.URLLoaderDataFormat;
	import flash.net.URLRequest;
	import flash.utils.ByteArray;

	public class InstanceNamesLoads extends Sprite
	{
		private var loaders:Array = [];

		public function InstanceNamesLoads()
		{
			var urls:Array = ["avm1.swf", "as3.swf", "missing.swf", "avm1.swf"];
			for (var i:int = 0; i < urls.length; i++)
			{
				var l:Loader = i == 3 ? loaders[0] : new Loader();
				loaders.push(l);
				listen(l, "url" + i);
				trace("before url" + i + " " + new Sprite().name);
				l.load(new URLRequest(urls[i]));
				trace("after url" + i + " " + new Sprite().name);
			}

			var bytes:URLLoader = new URLLoader();
			bytes.dataFormat = URLLoaderDataFormat.BINARY;
			bytes.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					var m:Loader = new Loader();
					loaders.push(m);
					listen(m, "bytes");
					trace("before bytes " + new Sprite().name);
					m.loadBytes(bytes.data as ByteArray);
					trace("after bytes " + new Sprite().name);
				});
			bytes.load(new URLRequest("as3.swf"));
		}

		private function listen(l:Loader, id:String):void
		{
			l.contentLoaderInfo.addEventListener(Event.INIT, function(e:Event):void
				{
					trace("init " + id + " " + l.content.name);
				});
			l.contentLoaderInfo.addEventListener("ioError", function(e:Event):void
				{
					trace("ioError " + id);
				});
		}
	}
}
