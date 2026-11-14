package
{
	import flash.display.Sprite;
	import flash.events.*;
	import flash.net.*;
	public class DesktopSmoke extends Sprite
	{
		private var socket:Socket;
		public function DesktopSmoke()
		{
			graphics.beginFill(0xff0000);
			graphics.drawRect(0, 0, 100, 50);
			trace("smoke: started");
			trace("smoke: url " + loaderInfo.url);
			// No click or key asked for these: the app opens none of them.
			for (var i:int = 0; i < 3; i++)
			{
				navigateToURL(new URLRequest("https://example.invalid/smoke" + i), "_blank");
			}
			load("beside", "data.txt");
			load("outside", "../secret.txt");
			load("network", "https://example.invalid/network");
			var port:int = int(/-(\d+)\.swf$/.exec(loaderInfo.url)[1]);
			socket = new Socket();
			socket.addEventListener(Event.CONNECT, function(e:Event):void
				{
					socket.writeUTFBytes("ping");
					socket.flush();
				});
			socket.addEventListener(ProgressEvent.SOCKET_DATA, function(e:ProgressEvent):void
				{
					trace("smoke: socket " + socket.readUTFBytes(socket.bytesAvailable));
				});
			socket.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void
				{
					trace("smoke: socket refused");
				});
			socket.connect("127.0.0.1", port);
		}
		private function load(label:String, url:String):void
		{
			var loader:URLLoader = new URLLoader();
			loader.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					trace("smoke: " + label + " " + loader.data);
				});
			loader.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void
				{
					trace("smoke: " + label + " refused");
				});
			loader.load(new URLRequest(url));
		}
	}
}
