// AIR 51's air.net.WebSocket, as the player declares it: the API of AIR's
// airglobal, which the player's playerglobal predates, with its methods
// native (WebSocket.ts). Compiled into air-library.ts with
// flash/events/WebSocketEvent.as by tests/player/air-library.ts.
package air.net {
  import flash.events.EventDispatcher;
  import flash.net.Socket;

  public class WebSocket extends EventDispatcher {
    public static const fmtTEXT:uint = 1;
    public static const fmtBINARY:uint = 2;
    public static const fmtCLOSE:uint = 8;
    public static const fmtPING:uint = 9;
    public static const fmtPONG:uint = 10;

    public function WebSocket() {
      super();
    }

    // Wrappers, since ASC keeps no defaults for a native method's parameters.
    public function connect(url:String, protocols:Vector.<String> = null):void {
      internalConnect(url, protocols);
    }

    private native function internalConnect(url:String, protocols:Vector.<String>):void;

    public native function sendMessage(opcode:uint, data:*):void;

    public function close(reasonCode:uint = 1000):void {
      internalClose(reasonCode);
    }

    private native function internalClose(reasonCode:uint):void;

    public native function get protocol():String;

    public native function set protocol(value:String):void;

    public native function get closeReason():int;

    public native function startServer(socket:Socket):void;
  }
}
