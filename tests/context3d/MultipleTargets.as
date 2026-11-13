package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.TextureBase;
  import flash.events.Event;
  import flash.utils.ByteArray;

  // Several colour outputs at once: which textures each output draws into, what binding
  // one output does to the others, and what a draw's outputs must agree on.
  public class MultipleTargets extends Sprite {
    public var complete:Boolean = false;
    private static const VERBOSE:Boolean = false;
    private var c:Context3D;
    private var quad:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var pixels:BitmapData;
    private var plain:Program3D;
    private var cubePlain:Program3D;
    private var four:Program3D;
    private var one:Program3D;
    private var second:Program3D;
    private var sampling:Program3D;

    public function MultipleTargets() {
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        c = slot.context3D;
        c.enableErrorChecking = true;
        c.configureBackBuffer(64, 64, 0, true);
        quad = c.createVertexBuffer(4, 4);
        quad.uploadFromVector(Vector.<Number>([-1, 1, 0, 0, 1, 1, 1, 0, 1, -1, 1, 1, -1, -1, 0, 1]), 0, 4);
        indices = c.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 0, 2, 3]), 0, 6);
        c.setVertexBufferAt(0, quad, 0, "float2");
        c.setVertexBufferAt(1, quad, 2, "float2");
        pixels = new BitmapData(64, 64, true, 0);
        plain = upload(1, [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x040f0000, 0xe4000001, 0, 0, 0]],
          [[0x28, 0x030f0000, 0xe4000000, 4, 0, 5]]);
        cubePlain = upload(1, [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x040f0000, 0xe4000001, 0, 0, 0]],
          [[3, 0x020f0000, 0xc6000000, 4, 0xe4000005, 1], [1, 0x020f0000, 0xe4000000, 2, 0xe4000004, 1],
           [0x28, 0x030f0000, 0xe4000000, 2, 0, 0x1005]]);
        four = upload(2, [[0, 0x030f0000, 0xe4000000, 0, 0, 0]], [[0, 0x030f0000, 0xe4000000, 1, 0, 0],
          [0, 0x030f0001, 0xe4000001, 1, 0, 0], [0, 0x030f0002, 0xe4000002, 1, 0, 0], [0, 0x030f0003, 0xe4000003, 1, 0, 0]]);
        one = upload(2, [[0, 0x030f0000, 0xe4000000, 0, 0, 0]], [[0, 0x030f0000, 0xe4000000, 1, 0, 0]]);
        second = upload(2, [[0, 0x030f0000, 0xe4000000, 0, 0, 0]], [[0, 0x030f0000, 0xe4000000, 1, 0, 0],
          [0, 0x030f0001, 0xe4000001, 1, 0, 0]]);
        sampling = upload(2, [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x040f0000, 0xe4000001, 0, 0, 0]],
          [[0x28, 0x020f0000, 0xe4000000, 4, 0, 5], [0, 0x030f0000, 0xe4000000, 2, 0, 0], [0, 0x030f0001, 0xe4000000, 2, 0, 0]]);
        c.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1,
          1, -1, -1, 0, 0, 2, 2, 0]));
        run();
        c.dispose(false);
        complete = true;
        trace("multipletargets complete");
      });
      slot.requestContext3D("auto", "standard");
    }

    private function agal(version:int, fragment:Boolean, rows:Array):ByteArray {
      var b:ByteArray = new ByteArray();
      b.endian = "littleEndian";
      b.writeByte(0xa0);
      b.writeUnsignedInt(version);
      b.writeByte(0xa1);
      b.writeByte(fragment ? 1 : 0);
      for (var i:int = 0; i < rows.length; i++) {
        for (var j:int = 0; j < 6; j++) {
          b.writeUnsignedInt(rows[i][j]);
        }
      }
      return b;
    }

    private function upload(version:int, vertex:Array, fragment:Array):Program3D {
      var p:Program3D = c.createProgram();
      p.upload(agal(version, false, vertex), agal(version, true, fragment));
      return p;
    }

    private function test(label:String, f:Function):void {
      try {
        f();
        trace("multipletargets", label, "accepted");
      } catch (e:Error) {
        trace("multipletargets", label, e.name, e.errorID);
        if (VERBOSE) { trace("message", e.message); }
      }
    }

    // The colour programs read no uv: AIR refuses a draw with a stream its program does not read.
    private function draw(program:Program3D):void {
      c.setVertexBufferAt(1, program == sampling ? quad : null, 2, "float2");
      c.setProgram(program);
      c.drawTriangles(indices);
    }

    private function show(label:String, texture:TextureBase, isCube:Boolean = false):void {
      try {
        c.setRenderToBackBuffer();
        c.setVertexBufferAt(1, quad, 2, "float2");
        c.setProgram(isCube ? cubePlain : plain);
        c.setTextureAt(0, texture);
        c.clear(0.5, 0.5, 0.5, 1);
        c.drawTriangles(indices);
        c.setTextureAt(0, null);
        c.drawToBitmapData(pixels);
        trace("multipletargets", label, pixels.getPixel32(16, 16).toString(16), pixels.getPixel32(48, 48).toString(16));
      } catch (e:Error) {
        c.setTextureAt(0, null);
        trace("multipletargets", label, e.name, e.errorID);
        if (VERBOSE) { trace("message", e.message); }
      }
    }

    private function showAll(label:String, targets:Array):void {
      for (var i:int = 0; i < targets.length; i++) {
        show(label + "-" + i, targets[i]);
      }
    }

    private function bindAll(targets:Array, depth:Boolean = false):void {
      for (var i:int = 0; i < targets.length; i++) {
        c.setRenderToTexture(targets[i], depth && i == 0, 0, 0, i);
      }
    }

    private function fresh(targets:Array):void {
      for (var i:int = 0; i < targets.length; i++) {
        c.setRenderToTexture(targets[i]);
        c.clear(0, 0, 0, 1);
      }
      c.setRenderToBackBuffer();
    }

    private function run():void {
      var t:Array = [];
      for (var i:int = 0; i < 4; i++) {
        t.push(c.createTexture(2, 2, "bgra", true));
      }

      fresh(t);
      test("four-clear", function():void { bindAll(t); c.clear(0.25, 0.5, 0.75, 1); });
      showAll("four-cleared", t);
      test("four-draw", function():void { bindAll(t); draw(four); });
      showAll("four-drawn", t);

      fresh(t);
      test("four-one-output", function():void { bindAll(t); draw(one); });
      showAll("four-one-output", t);

      fresh(t);
      test("first-only", function():void { c.setRenderToTexture(t[0]); draw(four); });
      showAll("first-only", t);

      fresh(t);
      test("kept-after-zero", function():void {
        c.setRenderToTexture(t[1], false, 0, 0, 1);
        c.setRenderToTexture(t[0]);
        draw(second);
      });
      showAll("kept-after-zero", t.slice(0, 2));

      fresh(t);
      test("reset-by-back-buffer", function():void {
        c.setRenderToTexture(t[1], false, 0, 0, 1);
        c.setRenderToBackBuffer();
        c.setRenderToTexture(t[0]);
        draw(second);
      });
      showAll("reset-by-back-buffer", t.slice(0, 2));

      fresh(t);
      test("unbound-by-null", function():void {
        bindAll(t.slice(0, 2));
        c.setRenderToTexture(null, false, 0, 0, 1);
        draw(second);
      });
      showAll("unbound-by-null", t.slice(0, 2));

      fresh(t);
      test("gap", function():void {
        c.setRenderToTexture(t[0]);
        c.setRenderToTexture(t[2], false, 0, 0, 2);
        draw(second);
      });
      showAll("gap", t.slice(0, 3));

      fresh(t);
      test("output-alone-clear", function():void {
        c.setRenderToBackBuffer();
        c.setRenderToTexture(t[1], false, 0, 0, 1);
        c.clear(1, 0, 1, 1);
      });
      test("output-alone-draw", function():void { draw(second); });
      showAll("output-alone", t.slice(0, 2));
      test("output-alone-read", function():void { c.drawToBitmapData(pixels); trace("multipletargets", "back", pixels.getPixel32(16, 16).toString(16)); });

      fresh(t);
      test("three-of-four", function():void { bindAll(t.slice(0, 3)); draw(four); });
      test("two-written-four-bound", function():void { bindAll(t); draw(second); });
      test("present-resets", function():void {
        bindAll(t.slice(0, 2));
        c.present();
        c.setRenderToTexture(t[0]);
        draw(second);
      });
      showAll("present-resets", t.slice(0, 2));

      var big:* = c.createTexture(4, 4, "bgra", true);
      var bigRect:* = c.createRectangleTexture(2, 2, "bgra", true);
      var half:* = c.createTexture(2, 2, "rgbaHalfFloat", true);
      var packed:* = c.createTexture(2, 2, "bgrPacked565", true);
      var faces:* = c.createCubeTexture(2, "bgra", true);
      fresh([big, bigRect, half, packed]);
      for (var face:int = 0; face < 6; face++) {
        c.setRenderToTexture(faces, false, 0, face);
        c.clear(0, 0, 0, 1);
      }
      fresh(t);
      test("sizes-bind", function():void { c.setRenderToTexture(t[0]); c.setRenderToTexture(big, false, 0, 0, 1); });
      test("sizes-clear", function():void { c.clear(0, 1, 1, 1); });
      test("sizes-draw", function():void { draw(second); });
      show("sizes-0", t[0]);
      show("sizes-1", big);
      test("rectangle", function():void { c.setRenderToTexture(t[0]); c.setRenderToTexture(bigRect, false, 0, 0, 1); draw(second); });
      show("rectangle-1", bigRect);
      test("formats", function():void { c.setRenderToTexture(t[0]); c.setRenderToTexture(half, false, 0, 0, 1); c.setRenderToTexture(packed, false, 0, 0, 2); draw(four); });
      show("formats-1", half);
      show("formats-2", packed);
      test("cube-face", function():void { c.setRenderToTexture(t[0]); c.setRenderToTexture(faces, false, 0, 1, 1); draw(second); });
      show("cube-face", faces, true);
      test("depth", function():void { bindAll(t.slice(0, 2), true); c.clear(0, 0, 0, 1); draw(second); });
      showAll("depth", t.slice(0, 2));
      test("antialias-differs", function():void { c.setRenderToTexture(t[0], false, 2); c.setRenderToTexture(t[1], false, 0, 0, 1); c.clear(0, 0, 0, 1); });
      fresh(t);
      test("sampled-output", function():void {
        c.setRenderToTexture(t[0]);
        c.setRenderToTexture(t[1], false, 0, 0, 1);
        c.setTextureAt(0, t[1]);
        draw(sampling);
      });
      c.setTextureAt(0, null);
      for (i = 0; i < 4; i++) {
        t[i].dispose();
      }
      big.dispose();
      bigRect.dispose();
      half.dispose();
      packed.dispose();
      faces.dispose();
    }
  }
}
