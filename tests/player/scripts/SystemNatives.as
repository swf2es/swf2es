package {
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.events.Event;
  import flash.events.NetStatusEvent;
  import flash.geom.Point;
  import flash.media.Video;
  import flash.net.FileReference;
  import flash.net.FileReferenceList;
  import flash.net.NetConnection;
  import flash.net.Responder;
  import flash.ui.GameInput;
  import flash.ui.Keyboard;

  // getObjectsUnderPoint, a local NetConnection, Responder, a FileReference
  // with no file, and the stage's properties a browser player reports.
  public class SystemNatives extends Sprite {
    public function SystemNatives() {
      connection();
      files();
      video();
      trace("keyboard", Keyboard.capsLock, Keyboard.numLock, Keyboard.hasVirtualKeyboard,
        Keyboard.physicalKeyboardType, Keyboard.isAccessible());
      trace("game input", GameInput.numDevices);
      try {
        GameInput.getDeviceAt(0);
      } catch (e:Error) {
        trace("no device", e.errorID);
      }
      // adl's harness adds the root after its constructor; the player has it on the stage before.
      if (stage) {
        added(null);
      } else {
        addEventListener(Event.ADDED_TO_STAGE, added);
      }
    }

    private function connection():void {
      var c:NetConnection = new NetConnection();
      c.addEventListener(NetStatusEvent.NET_STATUS, function(e:NetStatusEvent):void {
        trace("status", e.info.code, e.info.level);
      });
      trace("before", c.connected, c.uri, c.client == c, c.objectEncoding, c.proxyType,
        c.maxPeerConnections);
      try {
        trace(c.protocol);
      } catch (e:Error) {
        trace("protocol", e);
      }
      c.close();
      c.connect(null);
      trace("connected", c.connected, c.uri, c.protocol, c.usingTLS, c.nearID == "",
        c.unconnectedPeerStreams.length);
      c.connect(null);
      c.close();
      trace("closed", c.connected, c.uri);
      trace("responder", new Responder(function():void {}, null));
    }

    private function files():void {
      var f:FileReference = new FileReference();
      trace("file", f.data);
      for each (var name:String in ["name", "size", "type", "creationDate", "modificationDate"]) {
        try {
          trace(name, f[name]);
        } catch (e:Error) {
          trace(name, e.errorID);
        }
      }
      try {
        f.upload(null);
      } catch (e:Error) {
        trace("upload", e.errorID);
      }
      trace("list", new FileReferenceList().fileList);
    }

    private function video():void {
      for each (var size:Array in [[], [100], [100, 50], [0, 50], [1.9, 2.5]]) {
        var v:Video = size.length == 0 ? new Video() : size.length == 1 ? new Video(size[0]) :
          new Video(size[0], size[1]);
        trace("video", size, v.width, v.height, v.videoWidth, v.videoHeight, v.smoothing, v.deblocking);
      }
      try {
        new Video(-1, 10);
      } catch (e:Error) {
        trace("video -1", e.errorID);
      }
      var scaled:Video = new Video(100, 100);
      scaled.width = 50;
      scaled.attachNetStream(null);
      scaled.clear();
      trace("scaled", scaled.width, scaled.scaleX);
    }

    private function added(e:Event):void {
      var a:Sprite = square("a", 0, 0);
      var b:Sprite = square("b", 5, 5);
      var hidden:Sprite = square("hidden", 0, 0);
      hidden.visible = false;
      // What an invisible container or a mask holds is no more under the point.
      hidden.addChild(square("hiddenChild", 0, 0));
      var inner:Sprite = square("inner", 2, 2);
      b.addChild(inner);
      var mask:Sprite = square("mask", 0, 0);
      mask.addChild(square("maskChild", 0, 0));
      var masked:Sprite = square("masked", 0, 0);
      masked.mask = mask;
      var empty:Sprite = new Sprite();
      empty.name = "empty";
      for each (var s:Sprite in [a, b, hidden, mask, masked, empty]) {
        addChild(s);
      }

      var origin:Point = localToGlobal(new Point(0, 0));
      for each (var at:Array in [[3, 3], [8, 8], [12, 3], [50, 50]]) {
        var under:Array = getObjectsUnderPoint(new Point(origin.x + at[0], origin.y + at[1]));
        trace("under", at, under.map(function(o:*, ...rest):String { return o.name; }).join(","));
      }
      trace("inaccessible", areInaccessibleObjectsUnderPoint(origin));

      trace("stage color", stage.color.toString(16));
      stage.color = 0x12345678;
      trace("set", stage.color.toString(16));
      trace("colorCorrection", stage.colorCorrection, stage.colorCorrectionSupport);
      try {
        stage.colorCorrection = null;
      } catch (err:Error) {
        trace("null colorCorrection", err);
      }
      trace("scale", stage.contentsScaleFactor, stage.browserZoomFactor);
      trace("mouseLock", stage.mouseLock, "softKeyboardRect", stage.softKeyboardRect);
      trace("stage3Ds", stage.stage3Ds.length, stage.stage3Ds[0] is Stage3D);
      var s3:Stage3D = stage.stage3Ds[1];
      s3.x = 12.5;
      try {
        s3.y = 9000;
      } catch (err:Error) {
        trace("y = 9000", err);
      }
      trace("stage3D", s3.x, s3.y, s3.visible, s3.context3D);
    }

    private function square(name:String, x:Number, y:Number):Sprite {
      var s:Sprite = new Sprite();
      s.name = name;
      s.graphics.beginFill(0xff0000);
      s.graphics.drawRect(0, 0, 10, 10);
      s.x = x;
      s.y = y;
      return s;
    }
  }
}
