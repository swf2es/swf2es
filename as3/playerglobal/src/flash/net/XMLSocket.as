// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).
// Over a Socket, as Ruffle's (https://github.com/ruffle-rs/ruffle), core/src/
// avm2/globals/flash/net/XMLSocket.as: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors. Each message ends in a zero byte.

package flash.net
{
	import flash.events.DataEvent;
	import flash.events.Event;
	import flash.events.EventDispatcher;
	import flash.events.IOErrorEvent;
	import flash.events.ProgressEvent;
	import flash.events.SecurityErrorEvent;
	import flash.utils.ByteArray;

	public class XMLSocket extends EventDispatcher
	{
		private var _socket:Socket;
		// The message being received, until its zero byte.
		private var _message:ByteArray = new ByteArray();

		public function XMLSocket(host:String = null, port:int = 0)
		{
			_socket = new Socket();
			_socket.addEventListener(Event.CLOSE, closed);
			_socket.addEventListener(Event.CONNECT, forward);
			_socket.addEventListener(ProgressEvent.SOCKET_DATA, received);
			_socket.addEventListener(IOErrorEvent.IO_ERROR, forward);
			_socket.addEventListener(SecurityErrorEvent.SECURITY_ERROR, forward);
			if (host != null)
			{
				connect(host, port);
			}
		}

		public function connect(host:String, port:int):void
		{
			// No host is the SWF's own.
			_socket.connect(host != null ? host : domain, port);
		}

		public function send(object:*):void
		{
			const text:String = object is XML || object is XMLList ? object.toXMLString() : String(object);
			_socket.writeUTFBytes(text);
			_socket.writeByte(0);
			_socket.flush();
		}

		[API("662")]
		public function get timeout():int
		{
			return _socket.timeout;
		}

		[API("662")]
		public function set timeout(value:int):void
		{
			_socket.timeout = value;
		}

		public function close():void
		{
			_message.clear();
			_socket.close();
		}

		public function get connected():Boolean
		{
			return _socket.connected;
		}

		private function forward(event:Event):void
		{
			dispatchEvent(event);
		}

		private function closed(event:Event):void
		{
			_message.clear();
			dispatchEvent(event);
		}

		private function received(event:ProgressEvent):void
		{
			while (_socket.bytesAvailable > 0)
			{
				const byte:int = _socket.readByte();
				if (byte != 0)
				{
					_message.writeByte(byte);
					continue;
				}

				_message.position = 0;
				const data:String = _message.readUTFBytes(_message.length);
				_message.clear();
				dispatchEvent(new DataEvent(DataEvent.DATA, false, false, data));
			}
		}

		private native function get domain():String;
	}
}
