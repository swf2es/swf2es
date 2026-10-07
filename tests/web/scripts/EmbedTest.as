package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.IOErrorEvent;
  import flash.events.SecurityErrorEvent;
  import flash.external.ExternalInterface;
  import flash.media.Sound;
  import flash.net.Socket;
  import flash.utils.ByteArray;

  // The web test's SWF: blue where its page lets it script it, after a
  // round of ExternalInterface calls each way; green where the page does
  // not and ExternalInterface says so; red otherwise. It opens a socket
  // and plays a sound, for the element's destroy to let go of.
  public class EmbedTest extends Sprite {
    private var socket:Socket;
    private var sound:Sound;

    public function EmbedTest() {
      var color:uint = 0xff0000;
      if (ExternalInterface.available) {
        ExternalInterface.addCallback("echo", echo);
        ExternalInterface.addCallback("add", function (a:Number, b:Number):Number {
          return a + b;
        });
        ExternalInterface.addCallback("fail", function ():void {
          throw new Error("thrown in the SWF");
        });
        var hello:* = ExternalInterface.call("pageHello", "hi", [1, 2], {k: "v", d: new Date(5)});
        var inline:* = ExternalInterface.call("function (a) { return a * 2; }", 21);
        var params:Object = loaderInfo.parameters;
        ExternalInterface.call("report", {
          objectID: ExternalInterface.objectID,
          hello: hello,
          inline: inline,
          greeting: params.greeting,
          n: params.n
        });
        color = 0x0000ff;
      } else {
        try {
          ExternalInterface.call("pageHello");
        } catch (e:Error) {
          if (e.errorID == 2067) {
            color = 0x00ff00;
          }
        }
      }

      graphics.beginFill(color);
      graphics.drawRect(0, 0, 160, 120);
      graphics.endFill();

      socket = new Socket();
      socket.addEventListener(IOErrorEvent.IO_ERROR, ignore);
      socket.addEventListener(SecurityErrorEvent.SECURITY_ERROR, ignore);
      socket.connect("example.test", 1234);

      var samples:ByteArray = new ByteArray();
      for (var i:int = 0; i < 4410; i++) {
        samples.writeFloat(Math.sin(i / 10) * 0.1);
      }

      samples.position = 0;
      sound = new Sound();
      sound.loadPCMFromByteArray(samples, 4410, "float", false, 44100);
      sound.play(0, 1000);
    }

    private function echo(value:*):* {
      return {got: value, n: 42};
    }

    private function ignore(e:Event):void {
    }
  }
}
