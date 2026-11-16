// air.net.WebSocket over a host that sends frames as AIR does, as the
// desktop app's: what adl did for each step against a server of a probe's
// own is in WebSocket.test.ts, which plays the host.
package
{
	import air.net.WebSocket;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.WebSocketEvent;
	import flash.utils.ByteArray;

	public class HostFrames extends Sprite
	{
		private var _steps:Array;

		public function HostFrames()
		{
			_steps = [frames, refused, unoffered, selfSigned, accepted, closeCode];
			next();
		}

		private function next():void
		{
			if (_steps.length)
			{
				_steps.shift()();
			}
			else
			{
				trace("done");
			}
		}

		private function hex(b:ByteArray):String
		{
			var s:String = "";
			for (var i:int = 0; i < b.length; i++)
			{
				s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
			}

			return s;
		}

		private function bytes(values:Array):ByteArray
		{
			var b:ByteArray = new ByteArray();
			for (var i:int = 0; i < values.length; i++)
			{
				if (values[i] is String)
				{
					b.writeUTFBytes(values[i]);
				}
				else
				{
					b.writeByte(values[i]);
				}
			}

			return b;
		}

		/** A WebSocket whose every event is traced, then given to `then`; `last` ends the step. */
		private function fresh(name:String, last:String, then:Function = null):WebSocket
		{
			const w:WebSocket = new WebSocket();
			const types:Array = ["connect", "close", "ioError", "securityError", "certificateError", "websocketData"];
			for (var i:int = 0; i < types.length; i++)
			{
				w.addEventListener(types[i], function(e:Event):void
					{
						var s:String = name + " " + e;
						if (e is WebSocketEvent)
						{
							s += " format=" + WebSocketEvent(e).format + " hex=" + hex(WebSocketEvent(e).data as ByteArray);
						}

						trace(s + " closeReason=" + w.closeReason);
						if (then != null)
						{
							then(e, w);
						}

						if (e.type == last)
						{
							next();
						}
					});
			}

			return w;
		}

		private function frames():void
		{
			fresh("frames", "close", function(e:Event, w:WebSocket):void
				{
					if (e.type == "connect")
					{
						w.sendMessage(WebSocket.fmtPING, bytes(["cping"]));
						w.sendMessage(WebSocket.fmtPONG, bytes(["cpong"]));
						w.sendMessage(WebSocket.fmtTEXT, bytes([0xef, 0xbb, 0xbf, "bom"]));
						w.sendMessage(WebSocket.fmtTEXT, "go");
						w.sendMessage(3, "reserved");
					}
					else if (e is WebSocketEvent && WebSocketEvent(e).format == WebSocket.fmtBINARY)
					{
						w.sendMessage(WebSocket.fmtCLOSE, bytes([0x0f, 0xa1, "bye"]));
					}
				}).connect("ws://host.test/frames");
		}

		private function refused():void
		{
			fresh("refused", "close").connect("ws://host.test/refused");
		}

		private function unoffered():void
		{
			fresh("unoffered", "ioError").connect("ws://host.test/unoffered", Vector.<String>(["x"]));
		}

		private function selfSigned():void
		{
			fresh("self", "ioError").connect("wss://host.test/self");
		}

		private function accepted():void
		{
			fresh("accepted", "connect", function(e:Event, w:WebSocket):void
				{
					if (e.type == "certificateError")
					{
						e.preventDefault();
					}
				}).connect("wss://host.test/accepted");
		}

		private function closeCode():void
		{
			fresh("code", "connect", function(e:Event, w:WebSocket):void
				{
					if (e.type == "connect")
					{
						w.close(1001);
						trace("code closeReason=" + w.closeReason);
					}
				}).connect("ws://host.test/code");
		}
	}
}
