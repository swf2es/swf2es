package
{
	import flash.data.EncryptedLocalStore;
	import flash.desktop.NativeApplication;
	import flash.display.Screen;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.HTTPStatusEvent;
	import flash.events.IOErrorEvent;
	import flash.events.InvokeEvent;
	import flash.filesystem.File;
	import flash.filesystem.FileMode;
	import flash.filesystem.FileStream;
	import flash.net.URLLoader;
	import flash.net.URLRequest;
	import flash.system.Security;
	import flash.utils.ByteArray;

	// An AIR application a page plays from its package: its URL, sandbox,
	// window, screen and launch; what File finds in its directory and AIR's others;
	// a file read by its app: URL, by its file: URL, and a missing one, and
	// by a FileStream at once and over frames; a file in its storage, which
	// counts its runs, written and loaded by its app-storage: URL; an
	// EncryptedLocalStore item counting them too; a temporary file, written
	// and read, and a temporary directory, in the cache directory; given the
	// page's site, a URL its server answers 404, whose body AIR gives it, a load that
	// completes where httpResponseStatus is listened for and fails without;
	// and its exit, once the reads are done.
	public class AirWebTest extends Sprite
	{
		private var _pending:int = 5;

		public function AirWebTest()
		{
			trace("air: url " + loaderInfo.url);
			trace("air: sandbox " + Security.sandboxType);
			trace("air: id " + NativeApplication.nativeApplication.applicationID);
			trace("air: window " + stage.nativeWindow.title + " " + stage.nativeWindow.bounds.width + "x" + stage.nativeWindow.bounds.height);
			var main:Screen = Screen.mainScreen;
			trace("air: screen " + (main.bounds.width > 0 && main.bounds.containsRect(main.visibleBounds)) + " " + (main.colorDepth >= 8) + " " + Screen.screens.length + " " + Screen.getScreensForRectangle(stage.nativeWindow.bounds).length);
			NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, invoked);
		}

		private function invoked(e:InvokeEvent):void
		{
			// A third argument is the page's site, whose port is any.
			trace("air: invoke " + e.arguments.slice(0, 2).join("|") + " " + e.currentDirectory.exists);
			var data:File = File.applicationDirectory.resolvePath("data/hello.txt");
			trace("air: files " + data.exists + " " + data.size + " " + File.applicationDirectory.resolvePath("missing.txt").exists + " " + File.applicationStorageDirectory.exists + " " + File.documentsDirectory.isDirectory);
			var names:Array = [];
			var listing:Array = File.applicationDirectory.getDirectoryListing();
			for (var i:int = 0; i < listing.length; i++)
			{
				names.push(listing[i].name);
			}

			trace("air: listing " + names.join(","));
			var stream:FileStream = new FileStream();
			stream.open(data, FileMode.READ);
			trace("air: stream " + stream.readUTFBytes(stream.bytesAvailable));
			stream.close();
			var before:ByteArray = EncryptedLocalStore.getItem("runs");
			var itemRuns:int = before ? before.readInt() : 0;
			var after:ByteArray = new ByteArray();
			after.writeInt(itemRuns + 1);
			EncryptedLocalStore.setItem("runs", after);
			trace("air: items " + itemRuns);
			var saved:File = File.applicationStorageDirectory.resolvePath("saves/runs.txt");
			var runs:int = 0;
			if (saved.exists)
			{
				stream.open(saved, FileMode.READ);
				runs = int(stream.readUTFBytes(stream.bytesAvailable));
				stream.close();
			}

			stream.open(saved, FileMode.WRITE);
			stream.writeUTFBytes(String(runs + 1));
			stream.close();
			trace("air: saved " + runs);
			var temp:File = File.createTempFile();
			var empty:Boolean = temp.exists && temp.size == 0;
			stream.open(temp, FileMode.WRITE);
			stream.writeUTFBytes("temporary");
			stream.close();
			stream.open(temp, FileMode.READ);
			var back:String = stream.readUTFBytes(stream.bytesAvailable);
			stream.close();
			var tempDirectory:File = File.createTempDirectory();
			trace("air: temp " + back + " " + empty + " " + temp.parent.nativePath + " " + tempDirectory.isDirectory + " " + tempDirectory.getDirectoryListing().length + " " + (temp.nativePath != tempDirectory.nativePath) + " " + /^fla[0-9a-f]{1,4}\.tmp$/.test(temp.name));
			var async:FileStream = new FileStream();
			async.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					trace("air: async stream " + async.readUTFBytes(async.bytesAvailable));
					async.close();
					done();
				});
			async.openAsync(data, FileMode.READ);
			load("app", data.url);
			load("file", new File(data.nativePath).url);
			load("missing", "app:/missing.txt");
			load("storage", saved.url);
			if (e.arguments.length > 2)
			{
				_pending += 2;
				load("gone", e.arguments[2] + "/web-test/gone.txt", true);
				load("gone unheard", e.arguments[2] + "/web-test/gone.txt");
			}
		}

		private function load(label:String, url:String, status:Boolean = false):void
		{
			var loader:URLLoader = new URLLoader();
			if (status)
			{
				loader.addEventListener(HTTPStatusEvent.HTTP_RESPONSE_STATUS, function(e:HTTPStatusEvent):void
					{
						trace("air: " + label + " status " + e.status);
					});
			}

			loader.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					trace("air: " + label + " " + loader.data);
					done();
				});
			loader.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void
				{
					trace("air: " + label + " refused" + (loader.data ? " " + loader.data : ""));
					done();
				});
			loader.load(new URLRequest(url));
		}

		private function done():void
		{
			_pending--;
			if (_pending == 0)
			{
				trace("air: exit");
				NativeApplication.nativeApplication.exit(3);
			}
		}
	}
}
