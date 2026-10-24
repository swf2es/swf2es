package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.Texture;
  import flash.events.Event;
  import flash.utils.ByteArray;
  import flash.geom.Rectangle;

  public class Stencil extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var program:Program3D;
    private var pixels:BitmapData;

    public function Stencil() {
      if (stage) { start(); }
      else { addEventListener(Event.ADDED_TO_STAGE, start); }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        context = slot.context3D;
        context.enableErrorChecking = true;
        context.configureBackBuffer(64, 64, 0, true);
        vertices = context.createVertexBuffer(3, 4);
        vertices.uploadFromVector(Vector.<Number>([-0.8, -0.8, 0, 1, 0.8, -0.8, 0, 1, 0, 0.8, 0, 1]), 0, 3);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 0, 2, 1]), 0, 6);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        program = context.createProgram();
        program.upload(shader(false), shader(true));
        context.setProgram(program);
        pixels = new BitmapData(64, 64, true, 0);
        run();
        context.dispose(false);
        errors("disposed-");
        vertices.dispose();
        indices.dispose();
        program.dispose();
        pixels.dispose();
        complete = true;
        trace("stencil complete");
      });
      slot.requestContext3D("auto", "baseline");
    }

    private function shader(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0);
      bytes.writeUnsignedInt(1);
      bytes.writeByte(0xa1);
      bytes.writeByte(fragment ? 1 : 0);
      bytes.writeUnsignedInt(0);
      bytes.writeUnsignedInt(0x030f0000);
      bytes.writeUnsignedInt(0xe4000000);
      bytes.writeUnsignedInt(fragment ? 1 : 0);
      bytes.writeUnsignedInt(0);
      bytes.writeUnsignedInt(0);
      return bytes;
    }

    private function draw(r:Number = 1, g:Number = 0, b:Number = 0, a:Number = 1, first:int = 0):void {
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([r, g, b, a]));
      context.drawTriangles(indices, first, 1);
    }

    private function sample():String {
      context.drawToBitmapData(pixels);
      return pixels.getPixel32(pixels.width / 2, pixels.height / 2).toString(16);
    }

    private function probe(label:String, action:Function):void {
      try { action(); trace("stencil", label, "accepted"); }
      catch (error:Error) { trace("stencil", label, error.name, error.errorID); }
    }

    // Read the stencil through eight independent masked color tests.
    private function value():int {
      context.setColorMask(true, true, true, true);
      context.setDepthTest(false, "always");
      context.setStencilActions("frontAndBack", "equal");
      var result:int = 0;
      for (var bit:int = 1; bit <= 128; bit <<= 1) {
        context.setStencilReferenceValue(bit, bit, 0);
        context.clear(0, 0, 1, 1, 1, 0, 1);
        draw();
        if (sample() == "ffff0000") { result |= bit; }
      }
      return result;
    }

    private function reset(stencil:uint = 0):void {
      context.setStencilActions();
      context.setStencilReferenceValue(0);
      context.setDepthTest(false, "always");
      context.setColorMask(true, true, true, true);
      context.clear(0, 0, 1, 1, 1, stencil);
    }

    private function errors(prefix:String):void {
      probe(prefix + "actions", function():void { context.setStencilActions(); });
      probe(prefix + "reference", function():void { context.setStencilReferenceValue(0xffffffff, 0xffffffff, 0xffffffff); });
      probe(prefix + "face", function():void { context.setStencilActions("invalid"); });
      probe(prefix + "compare", function():void { context.setStencilActions("frontAndBack", "invalid"); });
      probe(prefix + "pass", function():void { context.setStencilActions("frontAndBack", "always", "invalid"); });
      probe(prefix + "depth", function():void { context.setStencilActions("frontAndBack", "always", "keep", "invalid"); });
      probe(prefix + "fail", function():void { context.setStencilActions("frontAndBack", "always", "keep", "keep", "invalid"); });
    }

    private function run():void {
      context.clear(0, 0, 1, 1);
      draw();
      trace("stencil default", sample());
      var modes:Array = ["always", "never", "less", "lessEqual", "equal", "notEqual", "greaterEqual", "greater"];
      for (var m:int = 0; m < modes.length; m++) {
        for (var ref:int = 4; ref <= 6; ref++) {
          reset(5);
          context.setStencilActions("frontAndBack", modes[m]);
          context.setStencilReferenceValue(ref);
          draw();
          trace("stencil compare", modes[m], ref, sample());
        }
      }
      var actions:Array = ["keep", "zero", "set", "incrementSaturate", "decrementSaturate", "invert", "incrementWrap", "decrementWrap"];
      var seeds:Array = [0, 85, 255];
      for (var a:int = 0; a < actions.length; a++) {
        for (var branch:int = 0; branch < 4; branch++) {
          for (var s:int = 0; s < seeds.length; s++) {
            reset(seeds[s]);
            context.setColorMask(false, false, false, false);
            context.setDepthTest(false, (branch & 1) ? "never" : "always");
            context.setStencilReferenceValue(42);
            context.setStencilActions("frontAndBack", (branch & 2) ? "never" : "always",
              branch == 0 ? actions[a] : "keep",
              (branch & 1) ? actions[a] : "keep",
              (branch & 2) ? actions[a] : "keep");
            draw();
            trace("stencil action", actions[a], branch, seeds[s], value());
          }
        }
      }
      var faces:Array = ["none", "front", "back", "frontAndBack"];
      for (var f:int = 0; f < faces.length; f++) {
        for (var winding:int = 0; winding < 2; winding++) {
          reset(0);
          context.setStencilActions(faces[f], "never");
          draw(1, 0, 0, 1, winding * 3);
          trace("stencil face", faces[f], winding, sample());
        }
      }
      // A new face selection must define whether the other face retains its state.
      reset();
      context.setStencilActions("front", "never");
      context.setStencilActions("back", "always");
      draw(1, 0, 0, 1, 3);
      trace("stencil face-switch", sample());

      context.setStencilActions("frontAndBack", "never");
      context.setStencilActions("none");
      context.clear(0, 0, 1, 1);
      draw();
      trace("stencil none-after-never", sample());
      reset(85);
      context.setDepthTest(false, "never");
      context.setStencilReferenceValue(42);
      context.setStencilActions("frontAndBack", "never", "keep", "zero", "set");
      draw();
      trace("stencil simultaneous-fail", value());

      var masks:Array = [0, 15, 240, 255, 511, 0xffffffff];
      for (var k:int = 0; k < masks.length; k++) {
        reset(85);
        context.setStencilReferenceValue(170, 255, masks[k]);
        context.setStencilActions("frontAndBack", "always", "set");
        draw();
        trace("stencil write-mask", masks[k], value());
        for (var reference:int = 0x155; reference <= 0x15a; reference += 5) {
          reset(85);
          context.setStencilReferenceValue(reference, masks[k], 0);
          context.setStencilActions("frontAndBack", "equal");
          draw();
          trace("stencil read-mask", masks[k], reference, sample());
        }
      }
      var clears:Array = [0, 42, 255, 256, 511, 0xffffffff];
      for (k = 0; k < clears.length; k++) {
        reset();
        context.setStencilReferenceValue(0, 255, 0);
        context.setScissorRectangle(new Rectangle(0, 0, 1, 1));
        context.clear(0, 0, 0, 1, 1, clears[k], 4);
        context.setScissorRectangle(null);
        trace("stencil clear", clears[k], value());
      }
      // Clear must restore the draw-time write mask.
      reset();
      context.setStencilReferenceValue(255, 255, 15);
      context.clear(0, 0, 1, 1, 1, 170);
      context.setStencilActions("frontAndBack", "always", "set");
      draw();
      trace("stencil clear-restores-mask", value());
      for (var quality:int = 0; quality <= 4; quality += 4) {
        context.configureBackBuffer(64, 64, quality, true);
        reset(77);
        context.setStencilActions("frontAndBack", "equal");
        context.setStencilReferenceValue(77);
        context.configureBackBuffer(64, 64, quality, true);
        draw();
        trace("stencil same-config", quality, sample());
        context.present();
        context.clear(0, 0, 1, 1, 1, 77);
        draw();
        trace("stencil present", quality, sample());
      }
      context.configureBackBuffer(32, 32, 0, true);
      pixels.dispose();
      pixels = new BitmapData(32, 32, true, 0);
      context.clear(0, 0, 1, 1, 1, 77);
      draw();
      trace("stencil resize", sample());
      targetChecks();
      // A rejected setter must not partially replace the previous state.
      reset();
      context.setStencilActions("frontAndBack", "never");
      probe("invalid-preserves", function():void { context.setStencilActions("frontAndBack", "always", "invalid"); });
      draw();
      trace("stencil invalid-state", sample());
      errors("live-");
    }
    private function targetChecks():void {
      var target:Texture = context.createTexture(32, 32, "bgra", true);
      var vs:ByteArray = shader(false);
      vs.position = vs.length;
      vs.writeUnsignedInt(0); vs.writeUnsignedInt(0x040f0000);
      vs.writeUnsignedInt(0xe4000000); vs.writeUnsignedInt(1);
      vs.writeUnsignedInt(0); vs.writeUnsignedInt(0);
      var fs:ByteArray = shader(true);
      fs.position = 7;
      fs.writeUnsignedInt(0x28); fs.writeUnsignedInt(0x030f0000);
      fs.writeUnsignedInt(0xe4000000); fs.writeUnsignedInt(4);
      fs.writeUnsignedInt(0); fs.writeUnsignedInt(5);
      var sampled:Program3D = context.createProgram();
      sampled.upload(vs, fs);
      context.setProgramConstantsFromVector("vertex", 0, Vector.<Number>([0.5, 0.5, 0, 0]));
      reset(42);
      for (var step:int = 0; step < 6; step++) {
        context.setRenderToTexture(target, step != 2);
        context.setStencilActions();
        context.setStencilReferenceValue(13);
        context.setDepthTest(false, "always");
        if (step == 0) {
          // Initialization/clear must ignore a zero write mask.
          context.setStencilReferenceValue(13, 255, 0);
          context.clear(0, 0, 1, 1, 1, 13);
        } else {
          context.clear(0, 0, 1, 1, 1, 0, 1);
        }
        switch (step) {
          case 0:
          case 1:
          case 3: context.setStencilActions("frontAndBack", "equal"); break;
          case 2: context.setStencilActions("frontAndBack", "never"); break;
          case 4: context.setStencilActions("front", "never"); break;
          case 5: context.setStencilActions("back", "never"); break;
        }
        draw();
        context.setRenderToBackBuffer();
        context.setStencilActions("frontAndBack", "equal");
        context.setStencilReferenceValue(42);
        context.clear(0, 0, 1, 1, 1, 0, 1);
        draw();
        trace("stencil target-back", step, sample());
        context.setStencilActions();
        context.setTextureAt(0, target);
        context.setProgram(sampled);
        context.clear(0, 0, 0, 1, 1, 0, 1);
        context.drawTriangles(indices, 0, 1);
        trace("stencil target-color", step, sample());
        context.setTextureAt(0, null);
        context.setProgram(program);
      }
      target.dispose();
      sampled.dispose();
    }
  }
}
