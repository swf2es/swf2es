package
{
	import flash.desktop.NativeApplication;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.HTTPStatusEvent;
	import flash.events.IOErrorEvent;
	import flash.events.InvokeEvent;
	import flash.filesystem.File;
	import flash.net.URLLoader;
	import flash.net.URLRequest;
	import flash.system.Security;

	// A SWF that names AIR's classes, played alone by its URL: as an AIR
	// application whose directory holds it alone, its other files loaded
	// from beside it on the server, and its exit once that is done. A file
	// the server has none of beside it is a file that is not there, though
	// the server's 404 has a body and the load listens for its response.
	public class AirAloneTest extends Sprite
	{
		public function AirAloneTest()
		{
			trace("alone: url " + loaderInfo.url);
			trace("alone: sandbox " + Security.sandboxType);
			trace("alone: id " + NativeApplication.nativeApplication.applicationID);
			trace("alone: title " + stage.nativeWindow.title);
			NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, invoked);
		}

		private function invoked(e:InvokeEvent):void
		{
			var names:Array = [];
			var listing:Array = File.applicationDirectory.getDirectoryListing();
			for (var i:int = 0; i < listing.length; i++)
			{
				names.push(listing[i].name);
			}

			trace("alone: listing " + names.join(","));
			load("beside", "data/hello.txt", false, function():void
				{
					load("no file", "data/gone.txt", true, function():void
						{
							NativeApplication.nativeApplication.exit(5);
						});
				});
		}

		private function load(label:String, url:String, status:Boolean, then:Function):void
		{
			var loader:URLLoader = new URLLoader();
			loader.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					trace("alone: " + label + " " + loader.data);
					then();
				});
			loader.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void
				{
					trace("alone: " + label + " refused " + loader.data);
					then();
				});
			if (status)
			{
				loader.addEventListener(HTTPStatusEvent.HTTP_RESPONSE_STATUS, function(e:HTTPStatusEvent):void
					{
						trace("alone: " + label + " status " + e.status);
					});
			}

			loader.load(new URLRequest(url));
		}
	}
}
