// AIR 51's flash.events.WebSocketEvent, as the player declares it (see
// air/net/WebSocket.as). Every read of data starts it over, and stringData
// is the whole of a text message's bytes, as adl gives them.
package flash.events {
  import flash.utils.ByteArray;

  public class WebSocketEvent extends Event {
    public static const DATA:String = "websocketData";

    private var _format:uint;
    private var _data:ByteArray;

    public function WebSocketEvent(type:String, format:uint, data:ByteArray) {
      super(type, false, false);
      _format = format;
      _data = data;
    }

    public function get format():uint {
      return _format;
    }

    public function get data():ByteArray {
      _data.position = 0;
      return _data;
    }

    public function get stringData():String {
      if (_format != 1) {
        return null;
      }

      _data.position = 0;
      return _data.readUTFBytes(_data.length);
    }
  }
}
