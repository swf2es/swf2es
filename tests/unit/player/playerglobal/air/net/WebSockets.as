// air.net.WebSocket against the echo server, a step at a time, each begun by
// the event the last awaited. What adl traces for the same calls is in
// WebSocket.test.ts, with where the player must differ.
package {
  import air.net.WebSocket;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.WebSocketEvent;
  import flash.net.Socket;
  import flash.utils.ByteArray;
  import flash.utils.getQualifiedClassName;

  public class WebSockets extends Sprite {
    private var base:String;
    private var inAdl:Boolean;
    private var steps:Array;

    public function WebSockets() {
      // The echo server's port; adl's harness gives no parameters, and runs the server at 18765.
      inAdl = !loaderInfo.parameters.port;
      base = "ws://127.0.0.1:" + (inAdl ? 18765 : loaderInfo.parameters.port);
      steps = [calls, localClose, refused, interrupted, closeFrame, codes, remoteEnd];
      next();
    }

    private function next():void {
      if (steps.length) {
        steps.shift()();
      } else {
        trace("done");
      }
    }

    private function t(label:String, f:Function):void {
      try {
        var r:* = f();
        trace(label + ": ok" + (r === undefined ? "" : " " + r));
      } catch (e:Error) {
        trace(label + ": " + getQualifiedClassName(e) + " " + e.errorID + " " + e.message);
      }
    }

    private function fresh(name:String):WebSocket {
      var w:WebSocket = new WebSocket();
      for each (var type:String in ["connect", "close", "ioError", "securityError", "websocketData"]) {
        w.addEventListener(type, function(e:Event):void {
          var s:String = name + " " + e;
          if (e is WebSocketEvent) {
            var d:WebSocketEvent = WebSocketEvent(e);
            d.data.position = 1;
            s += " format=" + d.format + " length=" + d.data.length + " string=" + d.stringData;
            s += " position=" + d.data.position;
          }
          trace(s + " closeReason=" + w.closeReason);
        });
      }

      return w;
    }

    /** Once `w`'s close is done, which dispatches nothing: a send throws then. */
    private function closed(w:WebSocket, then:Function):void {
      addEventListener(Event.ENTER_FRAME, function poll(e:Event):void {
        try {
          w.sendMessage(WebSocket.fmtTEXT, "poll");
        } catch (error:Error) {
          removeEventListener(Event.ENTER_FRAME, poll);
          then();
        }
      });
    }

    private function calls():void {
      trace([WebSocket.fmtTEXT, WebSocket.fmtBINARY, WebSocket.fmtCLOSE, WebSocket.fmtPING, WebSocket.fmtPONG], WebSocketEvent.DATA);
      var w:WebSocket = fresh("a");
      trace("closeReason " + w.closeReason + " protocol " + w.protocol);
      // Both crash adl, as AIR has no socket for them yet.
      if (!inAdl) {
        t("send before connect", function():* { w.sendMessage(WebSocket.fmtTEXT, "x"); });
        t("close before connect", function():* { w.close(); });
      }

      // On one of its own: a server, in adl, connects no more.
      var server:WebSocket = new WebSocket();
      t("startServer null", function():* { server.startServer(null); });
      t("startServer", function():* { server.startServer(new Socket()); });
      t("connect a server", function():* { server.connect("http://127.0.0.1/"); });
      t("connect null", function():* { w.connect(null); });
      t("connect http", function():* { w.connect("http://127.0.0.1/"); });
      t("connect WS", function():* { w.connect("WS://127.0.0.1/"); });
      t("set protocol", function():* { w.protocol = "chat"; return w.protocol; });
      t("connect", function():* { w.connect(base + "/a#fragment", Vector.<String>(["one", null, "two"])); });
      t("protocol while connecting", function():* { return w.protocol; });
      t("connect while connecting", function():* { w.connect(base + "/again"); });
      w.addEventListener("connect", function(e:Event):void {
        t("set protocol when open", function():* { w.protocol = "late"; });
        t("connect when open", function():* { w.connect(base + "/again"); });
        messages(w);
      });
    }

    private function messages(w:WebSocket):void {
      var b:ByteArray = new ByteArray();
      b.writeUTFBytes("biné");
      b.position = 2;
      t("text", function():* { w.sendMessage(WebSocket.fmtTEXT, "héllo"); });
      t("binary", function():* { w.sendMessage(WebSocket.fmtBINARY, b); return b.position; });
      t("text of bytes", function():* { w.sendMessage(WebSocket.fmtTEXT, b); });
      t("binary of a string", function():* { w.sendMessage(WebSocket.fmtBINARY, "str"); });
      t("number", function():* { w.sendMessage(WebSocket.fmtTEXT, 42); });
      t("null", function():* { w.sendMessage(WebSocket.fmtBINARY, null); });
      t("ping", function():* { w.sendMessage(WebSocket.fmtPING, "p"); });
      t("pong", function():* { w.sendMessage(WebSocket.fmtPONG, "p"); });
      t("reserved", function():* { w.sendMessage(3, "r"); });
      t("text in high bits", function():* { w.sendMessage(0x81, "high"); });
      t("split", function():* { w.sendMessage(WebSocket.fmtTEXT, "split"); });
      t("ask a close", function():* { w.sendMessage(WebSocket.fmtTEXT, "close 4001 bye"); });
      w.addEventListener("close", function(e:Event):void {
        t("send when closed", function():* { w.sendMessage(WebSocket.fmtTEXT, "x"); });
        t("close when closed", function():* { w.close(); });
        t("set protocol when closed", function():* { w.protocol = "z"; });
        t("connect when closed", function():* { w.connect(base + "/again"); });
        trace("protocol " + w.protocol);
        next();
      });
    }

    private function localClose():void {
      var w:WebSocket = fresh("b");
      w.connect(base + "/b");
      w.addEventListener("connect", function(e:Event):void {
        t("close 3001", function():* { w.close(3001); });
        trace("closeReason " + w.closeReason);
        t("send when closing", function():* { w.sendMessage(WebSocket.fmtTEXT, "late"); });
        t("close when closing", function():* { w.close(); });
        closed(w, function():void {
          trace("closeReason " + w.closeReason);
          next();
        });
      });
    }

    private function refused():void {
      var w:WebSocket = fresh("c");
      w.connect("ws://127.0.0.1:1/");
      w.addEventListener("ioError", function(e:Event):void {
        t("connect when failed", function():* { w.connect(base + "/again"); });
        t("send when failed", function():* { w.sendMessage(WebSocket.fmtTEXT, "x"); });
        t("close when failed", function():* { w.close(); });
        next();
      });
    }

    private function interrupted():void {
      var w:WebSocket = fresh("d");
      w.connect(base + "/d");
      t("send while connecting", function():* { w.sendMessage(WebSocket.fmtTEXT, "early"); });
      w.addEventListener("close", function(e:Event):void {
        t("send when closed", function():* { w.sendMessage(WebSocket.fmtTEXT, "x"); });
        next();
      });
    }

    private function closeFrame():void {
      var w:WebSocket = fresh("e");
      w.connect(base + "/e");
      w.addEventListener("connect", function(e:Event):void {
        var frame:ByteArray = new ByteArray();
        frame.writeShort(4002);
        frame.writeUTFBytes("why");
        t("close frame", function():* { w.sendMessage(WebSocket.fmtCLOSE, frame); });
      });
      w.addEventListener("close", function(e:Event):void {
        next();
      });
    }

    private function codes():void {
      var list:Array = [999, 65536 + 3002];
      var go:Function = function():void {
        if (!list.length) {
          next();
          return;
        }

        var code:uint = list.shift();
        var w:WebSocket = fresh("f" + code);
        w.connect(base + "/code" + code);
        w.addEventListener("connect", function(e:Event):void {
          t("close " + code, function():* { w.close(code); });
          closed(w, function():void {
            trace("closeReason " + w.closeReason);
            go();
          });
        });
      };
      go();
    }

    private function remoteEnd():void {
      var w:WebSocket = fresh("g");
      w.connect(base + "/g");
      w.addEventListener("connect", function(e:Event):void {
        w.sendMessage(WebSocket.fmtTEXT, "empty");
        w.sendMessage(WebSocket.fmtTEXT, "end");
      });
      w.addEventListener("close", function(e:Event):void {
        next();
      });
    }
  }
}
