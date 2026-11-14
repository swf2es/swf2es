package
{
	import flash.display.Sprite;
	import flash.events.*;
	import flash.net.*;
	import flash.system.Security;
	public class RemoteSmoke extends Sprite
	{
		private var sockets:Array = [];
		public function RemoteSmoke()
		{
			var p:Object = loaderInfo.parameters;
			trace("remote: url " + loaderInfo.url);
			trace("remote: sandbox " + Security.sandboxType);
			load("same", "data.txt");
			// A response that tells an error fails in Flash Player, its body unread.
			load("gone", "gone.txt");
			load("allowed", p.allowed);
			load("denied", p.denied);
			load("file", p.file);
			load("local", "file:///etc/hostname");
			connect("socket-ok", int(p.good));
			connect("socket-no", int(p.bad));
		}
		private function load(label:String, url:String):void
		{
			var loader:URLLoader = new URLLoader();
			loader.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					trace("remote: " + label + " " + loader.data);
				});
			loader.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void
				{
					trace("remote: " + label + " refused");
				});
			loader.load(new URLRequest(url));
		}
		private function connect(label:String, port:int):void
		{
			var socket:Socket = new Socket();
			sockets.push(socket);
			socket.addEventListener(Event.CONNECT, function(e:Event):void
				{
					socket.writeUTFBytes("ping");
					socket.flush();
				});
			socket.addEventListener(ProgressEvent.SOCKET_DATA, function(e:ProgressEvent):void
				{
					trace("remote: " + label + " " + socket.readUTFBytes(socket.bytesAvailable));
				});
			socket.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void
				{
					trace("remote: " + label + " refused");
				});
			socket.connect("127.0.0.1", port);
		}
	}
}
