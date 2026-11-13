package {
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.events.ErrorEvent;
  import flash.events.Event;
  import flash.display.BitmapData;
  import flash.geom.Matrix3D;
  import flash.utils.ByteArray;

  // What each profile grants: its name, its largest textures, the formats it creates,
  // its sampler, vertex and constant registers, and its colour outputs.
  public class Profiles extends Sprite {
    public var complete:Boolean = false;
    private static const VERBOSE:Boolean = false;
    private var profiles:Array = ["baselineConstrained", "baseline", "baselineExtended",
      "standardConstrained", "standard", "standardExtended"];
    private var matching:Array = [
      ["baseline", "baselineConstrained"],
      ["standardConstrained", "baseline"],
      ["baselineExtended", "standard", "baseline"],
      ["standardExtended", "standard", "standardConstrained", "baselineExtended", "baseline", "baselineConstrained"]];
    private var index:int = 0;
    private var c:Context3D;
    private var label:String;

    public function Profiles() {
      next();
    }

    private function next():void {
      var slot:Stage3D = stage.stage3Ds[0];
      var asked:Array;
      if (index < profiles.length) {
        asked = [profiles[index]];
      } else if (index < profiles.length + matching.length) {
        asked = matching[index - profiles.length];
      } else {
        clears(slot);
        return;
      }

      var matched:Boolean = index >= profiles.length;
      index++;
      var created:Function = function(event:Event):void {
        slot.removeEventListener(Event.CONTEXT3D_CREATE, created);
        slot.removeEventListener(ErrorEvent.ERROR, failed);
        c = slot.context3D;
        c.enableErrorChecking = true;
        if (matched) {
          trace("profiles matching", asked.join("+"), c.profile);
        } else {
          label = "profiles " + c.profile;
          check();
        }
        c.dispose(false);
        next();
      };
      var failed:Function = function(event:ErrorEvent):void {
        slot.removeEventListener(Event.CONTEXT3D_CREATE, created);
        slot.removeEventListener(ErrorEvent.ERROR, failed);
        trace("profiles", asked.join("+"), "error", event.errorID);
        next();
      };
      slot.addEventListener(Event.CONTEXT3D_CREATE, created);
      slot.addEventListener(ErrorEvent.ERROR, failed);
      if (matched) {
        slot.requestContext3DMatchingProfiles(Vector.<String>(asked));
      } else {
        slot.requestContext3D("auto", asked[0]);
      }
    }

    // What a clear's colour keeps of channels between bytes, in baseline, last: AIR under Wine
    // stopped answering a request after a context that read its back buffer.
    private function clears(slot:Stage3D):void {
      var created:Function = function(event:Event):void {
        slot.removeEventListener(Event.CONTEXT3D_CREATE, created);
        c = slot.context3D;
        c.configureBackBuffer(32, 32, 0, false);
        var read:BitmapData = new BitmapData(32, 32, true, 0);
        for each (var value:Array in [[0.5, 0.3, 0.9], [0.25, 0.75, 0.1], [0.999, 0.002, 0.6]]) {
          c.clear(value[0], value[1], value[2], 1);
          c.drawToBitmapData(read);
          trace("profiles clear", value.join(","), read.getPixel32(4, 4).toString(16));
        }
        complete = true;
        trace("profiles complete");
        c.dispose(false);
      };
      slot.addEventListener(Event.CONTEXT3D_CREATE, created);
      slot.requestContext3D("auto", "baseline");
    }

    private function test(name:String, f:Function):void {
      try {
        f();
        trace(label, name, "accepted");
      } catch (e:Error) {
        trace(label, name, e.name, e.errorID);
        if (VERBOSE) { trace("message", e.message); }
      }
    }

    private function agal(fragment:Boolean, row:Array):ByteArray {
      var b:ByteArray = new ByteArray();
      b.endian = "littleEndian";
      b.writeByte(0xa0);
      b.writeUnsignedInt(1);
      b.writeByte(0xa1);
      b.writeByte(fragment ? 1 : 0);
      for (var j:int = 0; j < 6; j++) {
        b.writeUnsignedInt(row[j]);
      }
      return b;
    }

    private function check():void {
      trace(label, "most", c.maxBackBufferWidth, c.maxBackBufferHeight);
      var size:int;
      for each (size in [2048, 4096, 8192]) {
        test("texture-wide-" + size, function():void { c.createTexture(size, 1, "bgra", false).dispose(); });
        test("texture-tall-" + size, function():void { c.createTexture(1, size, "bgra", false).dispose(); });
      }
      for each (size in [2048, 2049, 4096, 4097]) {
        test("rectangle-wide-" + size, function():void { c.createRectangleTexture(size, 1, "bgra", false).dispose(); });
      }
      for each (size in [1024, 2048, 4096]) {
        test("cube-" + size, function():void { c.createCubeTexture(size, "bgra", false).dispose(); });
      }

      var format:String;
      for each (format in ["bgra", "bgraPacked4444", "bgrPacked565", "rgbaHalfFloat"]) {
        test("format-texture-" + format, function():void { c.createTexture(64, 64, format, false).dispose(); });
        test("format-target-" + format, function():void { c.createTexture(64, 64, format, true).dispose(); });
        test("format-rectangle-" + format, function():void { c.createRectangleTexture(64, 64, format, true).dispose(); });
        test("format-cube-" + format, function():void { c.createCubeTexture(64, format, true).dispose(); });
      }

      var texture:* = c.createTexture(64, 64, "bgra", true);
      var buffer:* = c.createVertexBuffer(3, 4);
      var i:int;
      for each (i in [7, 8, 15, 16]) {
        test("sampler-" + i, function():void { c.setTextureAt(i, texture); c.setTextureAt(i, null); });
        test("sampler-state-" + i, function():void { c.setSamplerStateAt(i, "clamp", "nearest", "mipnone"); });
        test("vertex-buffer-" + i, function():void { c.setVertexBufferAt(i, buffer, 0, "float4"); c.setVertexBufferAt(i, null); });
      }

      var one:Vector.<Number> = Vector.<Number>([1, 2, 3, 4]);
      for each (i in [127, 128, 249, 250]) {
        test("vertex-constant-" + i, function():void { c.setProgramConstantsFromVector("vertex", i, one, 1); });
      }
      for each (i in [27, 28, 63, 64, 199, 200]) {
        test("fragment-constant-" + i, function():void { c.setProgramConstantsFromVector("fragment", i, one, 1); });
      }
      // Runs past the end, and a matrix's four registers.
      var two:Vector.<Number> = Vector.<Number>([1, 2, 3, 4, 5, 6, 7, 8]);
      test("vertex-constant-span-249", function():void { c.setProgramConstantsFromVector("vertex", 249, two, 2); });
      test("fragment-constant-span-199", function():void { c.setProgramConstantsFromVector("fragment", 199, two, 2); });
      test("vertex-constant-negative", function():void { c.setProgramConstantsFromVector("vertex", -1, one, 1); });
      test("vertex-matrix-248", function():void { c.setProgramConstantsFromMatrix("vertex", 248, new Matrix3D()); });
      test("vertex-matrix-250", function():void { c.setProgramConstantsFromMatrix("vertex", 250, new Matrix3D()); });
      test("fragment-matrix-198", function():void { c.setProgramConstantsFromMatrix("fragment", 198, new Matrix3D()); });

      for each (i in [0, 1, 3, 4, -1]) {
        test("color-output-" + i, function():void {
          c.setRenderToTexture(texture, false, 0, 0, i);
          c.setRenderToBackBuffer();
        });
      }
      // A stream bound that the program does not read, drawn in baseline alone: AIR under
      // Wine stopped answering at this draw in baselineExtended.
      if (c.profile == "baseline") test("unused-stream", function():void {
        c.configureBackBuffer(32, 32, 0, false);
        var vertices:* = c.createVertexBuffer(3, 2);
        vertices.uploadFromVector(Vector.<Number>([0, 0, 1, 0, 0, 1]), 0, 3);
        var triangle:* = c.createIndexBuffer(3);
        triangle.uploadFromVector(Vector.<uint>([0, 1, 2]), 0, 3);
        var program:* = c.createProgram();
        var vertex:ByteArray = agal(false, [0, 0x030f0000, 0xe4000000, 0, 0, 0]);
        var fragment:ByteArray = agal(true, [0, 0x030f0000, 0xe4000000, 1, 0, 0]);
        program.upload(vertex, fragment);
        c.setProgram(program);
        c.setVertexBufferAt(0, vertices, 0, "float2");
        c.setVertexBufferAt(1, vertices, 0, "float2");
        c.clear();
        c.drawTriangles(triangle);
      });
      c.setVertexBufferAt(1, null);
      buffer.dispose();
      texture.dispose();
    }
  }
}
