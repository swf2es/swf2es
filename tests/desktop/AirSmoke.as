package {
  import flash.desktop.NativeApplication;
  import flash.display.Screen;
  import flash.display.Sprite;
  import flash.events.*;
  import flash.filesystem.File;
  import flash.filesystem.FileMode;
  import flash.filesystem.FileStream;
  import flash.geom.Rectangle;
  import flash.net.*;
  import flash.system.Security;
  import flash.utils.ByteArray;
  import flash.utils.getDefinitionByName;
  public class AirSmoke extends Sprite {
    private var socket:Socket;
    private var webSockets:Array = [];
    public function AirSmoke() {
      trace("air: url " + loaderInfo.url);
      trace("air: sandbox " + Security.sandboxType);
      trace("air: title " + stage.nativeWindow.title);
      // The system's displays: the main one among them, and the one the window is on.
      var main:Screen = Screen.mainScreen;
      trace("air: screen " + (main.bounds.width > 0 && main.visibleBounds.height > 0) + " " + (main.colorDepth >= 8) + " " + (Screen.screens.length >= 1) + " " + Screen.getScreensForRectangle(stage.nativeWindow.bounds).length);
      NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, function (e:InvokeEvent):void {
        trace("air: invoke " + e.arguments.join("|") + " " + e.currentDirectory.exists);
        // app:/ has no parent, as adl's: up from its native path, under file:.
        var outside:File = new File(File.applicationDirectory.nativePath).parent.resolvePath("air-outside.txt");
        trace("air: files " + File.applicationDirectory.resolvePath("data.txt").exists + " " + outside.exists + " " + outside.url.indexOf("file:///"));
        var stream:FileStream = new FileStream();
        stream.open(File.applicationDirectory.resolvePath("data.txt"), FileMode.READ);
        trace("air: stream " + stream.readUTFBytes(stream.bytesAvailable));
        stream.close();
        // A temporary file and directory, on disk in the system's temporary directory: the
        // launch with arguments alone makes them, which the test removes.
        if (e.arguments.length > 0) {
          var temp:File = File.createTempFile();
          var empty:Boolean = temp.exists && temp.size == 0;
          stream.open(temp, FileMode.WRITE);
          stream.writeUTFBytes("temporary");
          stream.close();
          stream.open(temp, FileMode.READ);
          var back:String = stream.readUTFBytes(stream.bytesAvailable);
          stream.close();
          var tempDirectory:File = File.createTempDirectory();
          trace("air: temp " + back + " " + empty + " " + tempDirectory.isDirectory + " " + tempDirectory.getDirectoryListing().length + " " + (temp.parent.nativePath == File.cacheDirectory.nativePath) + " " + (temp.nativePath != tempDirectory.nativePath));
          trace("air: temp paths " + temp.nativePath + "|" + tempDirectory.nativePath);
        }
        load("app", "data.txt");
        load("file", outside.url);
        // Named in another case than on the disk, as an application made on Windows names files.
        var cased:File = File.applicationDirectory.resolvePath("Maps/Meadow/Level.TXT");
        stream.open(cased, FileMode.READ);
        trace("air: cased " + cased.exists + " " + stream.readUTFBytes(stream.bytesAvailable));
        stream.close();
        stream.open(new File(File.applicationDirectory.nativePath).resolvePath("MAPS/meadow/Saved.txt"), FileMode.WRITE);
        stream.writeUTFBytes("saved");
        stream.close();
        load("cased-app", "Maps/Meadow/Level.TXT");
        load("cased-file", new File(File.applicationDirectory.nativePath).resolvePath("maps/MEADOW/level.txt").url);
        if (e.arguments.length > 2) {
          load("http", e.arguments[2]);
          // A response that tells an error completes in AIR, its body the data.
          load("gone", e.arguments[2] + ".gone");
        }
        socket = new Socket();
        socket.addEventListener(Event.CONNECT, function (e:Event):void {
          socket.writeUTFBytes("ping");
          socket.flush();
        });
        socket.addEventListener(ProgressEvent.SOCKET_DATA, function (e:ProgressEvent):void {
          trace("air: socket " + socket.readUTFBytes(socket.bytesAvailable));
        });
        socket.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
          trace("air: socket refused");
        });
        socket.connect("127.0.0.1", int(e.arguments[0]));
        if (e.arguments.length > 3) {
          connectWebSocket("websocket", "ws://127.0.0.1:" + e.arguments[3] + "/smoke?q=1");
        }
        if (e.arguments.length > 4) {
          connectWebSocket("wss-address", "wss://127.0.0.1:" + e.arguments[4] + "/");
          connectWebSocket("wss-name", "wss://localhost:" + e.arguments[4] + "/");
        }
        // Full screen as an application asks for it: from no click or key, over a part of its stage.
        if (e.arguments.length > 1) {
          stage.addEventListener(FullScreenEvent.FULL_SCREEN, function (f:FullScreenEvent):void {
            trace("air: fullScreen " + f.fullScreen + " " + f.interactive + " " + stage.displayState);
          });
          // F11 is the application's own to act on, as AIR leaves it: adl has no key for full screen.
          stage.addEventListener(KeyboardEvent.KEY_DOWN, function (k:KeyboardEvent):void {
            if (k.keyCode == 122) {
              stage.displayState = stage.displayState == "normal" ? "fullScreenInteractive" : "normal";
            }
          });
          stage.fullScreenSourceRect = new Rectangle(0, 0, 50, 50);
          stage.displayState = "fullScreenInteractive";
          trace("air: displayState " + stage.displayState + " " + stage.stageWidth + "x" + stage.stageHeight);
        }
      });
    }
    private function connectWebSocket(label:String, url:String):void {
      // By name, and its event untyped: the playerglobal ASC compiles against has no AIR 51.
      var WebSocket:Class = getDefinitionByName("air.net.WebSocket") as Class;
      var webSocket:Object = new WebSocket();
      webSockets.push(webSocket);
      webSocket.addEventListener(Event.CONNECT, function (e:Event):void {
        trace("air: " + label + " open " + webSocket.protocol);
        webSocket.sendMessage(WebSocket.fmtTEXT, "ping");
      });
      webSocket.addEventListener("websocketData", function (event:Event):void {
        var e:Object = event;
        if (e.format == WebSocket.fmtTEXT) {
          trace("air: " + label + " text " + e.stringData);
          var bytes:ByteArray = new ByteArray();
          bytes.writeByte(1);
          bytes.writeByte(2);
          bytes.writeByte(255);
          webSocket.sendMessage(WebSocket.fmtBINARY, bytes);
        } else {
          trace("air: " + label + " binary " + e.data.length + " " + e.data[0] + "," + e.data[1] + "," + e.data[2]);
        }
      });
      webSocket.addEventListener(Event.CLOSE, function (e:Event):void {
        trace("air: " + label + " close " + webSocket.closeReason);
      });
      webSocket.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("air: " + label + " refused");
      });
      webSocket.connect(url, new <String>["other", "smoke"]);
    }
    private function load(label:String, url:String):void {
      var loader:URLLoader = new URLLoader();
      loader.addEventListener(Event.COMPLETE, function (e:Event):void {
        trace("air: " + label + " " + loader.data);
      });
      // AIR's alone, as the response's headers come: a file has none.
      loader.addEventListener(HTTPStatusEvent.HTTP_RESPONSE_STATUS, function (e:HTTPStatusEvent):void {
        var type:String = "";
        for each (var header:URLRequestHeader in e.responseHeaders) {
          if (header.name.toLowerCase() == "content-type") {
            type = header.value;
          }
        }
        trace("air: " + label + " status " + e.status + " " + e.redirected + " " + e.responseURL.split("/").pop() + " " + type);
      });
      loader.addEventListener(IOErrorEvent.IO_ERROR, function (e:IOErrorEvent):void {
        trace("air: " + label + " refused");
      });
      loader.load(new URLRequest(url));
    }
  }
}
