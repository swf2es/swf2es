package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.display3D.Context3D;
  import flash.display3D.IndexBuffer3D;
  import flash.display3D.Program3D;
  import flash.display3D.VertexBuffer3D;
  import flash.display3D.textures.Texture;
  import flash.display3D.textures.CubeTexture;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class SamplerStates extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var texture:Texture;
    private var pixels:BitmapData;
    private var vertex:ByteArray;

    public function SamplerStates() {
      if (stage) { start(); }
      else { addEventListener(Event.ADDED_TO_STAGE, start); }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        context = slot.context3D;
        context.enableErrorChecking = true;
        context.configureBackBuffer(64, 64, 0, false);
        vertices = context.createVertexBuffer(4, 6);
        vertices.uploadFromVector(Vector.<Number>([
          -1, 1, 0.5, 1, 0, 0, 1, 1, 0.5, 1, 1, 0,
          -1, -1, 0.5, 1, 0, 1, 1, -1, 0.5, 1, 1, 1
        ]), 0, 4);
        indices = context.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0, 1, 2, 2, 1, 3]), 0, 6);
        context.setVertexBufferAt(0, vertices, 0, "float4");
        context.setVertexBufferAt(1, vertices, 4, "float2");
        context.setCulling("none");
        pixels = new BitmapData(64, 64, true, 0);
        vertex = header(false);
        emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
        emit(vertex, 0, 0x040f0000, 0xe4000001, 0);
        run();
        vertices.dispose(); indices.dispose(); pixels.dispose(); texture.dispose();
        context.dispose(false);
        complete = true;
        trace("samplerstates complete");
      });
      slot.requestContext3D("auto", "baseline");
    }

    private function header(fragment:Boolean):ByteArray {
      var bytes:ByteArray = new ByteArray();
      bytes.endian = "littleEndian";
      bytes.writeByte(0xa0);
      bytes.writeUnsignedInt(1);
      bytes.writeByte(0xa1);
      bytes.writeByte(fragment ? 1 : 0);
      return bytes;
    }

    private function emit(bytes:ByteArray, op:uint, dest:uint, a:uint, at:uint, b:uint = 0, bt:uint = 0):void {
      bytes.writeUnsignedInt(op);
      bytes.writeUnsignedInt(dest);
      bytes.writeUnsignedInt(a);
      bytes.writeUnsignedInt(at);
      bytes.writeUnsignedInt(b);
      bytes.writeUnsignedInt(bt);
    }

    private function program(flags:uint, slot:uint = 0, dual:Boolean = false):Program3D {
      var fragment:ByteArray = header(true);
      emit(fragment, 3, 0x020f0000, 0xe4000000, 4, 0xe4000000, 1);
      emit(fragment, 0x28, dual ? 0x020f0001 : 0x030f0000, 0xe4000000, 2, slot, flags | 5);
      if (dual) {
        emit(fragment, 0x28, 0x020f0002, 0xe4000000, 2, 1, (flags ^ 0x10000000) | 5);
        emit(fragment, 3, 0x030f0000, 0xe4000001, 2, 0xe4000002, 2);
      }
      var p:Program3D = context.createProgram();
      p.upload(vertex, fragment);
      return p;
    }

    private function draw(label:String, scale:Number = 8):void {
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([scale, scale, 0, 1]));
      context.clear(0, 0, 0, 1);
      try {
        context.drawTriangles(indices);
        context.drawToBitmapData(pixels);
        trace("samplerstates", label, pixels.getPixel32(16, 16).toString(16), pixels.getPixel32(48, 48).toString(16),
          pixels.getPixel32(31, 31).toString(16), pixels.getPixel32(32, 32).toString(16),
          pixels.getPixel32(16, 48).toString(16), pixels.getPixel32(48, 16).toString(16));
      } catch (error:Error) { trace("samplerstates", label, error.name, error.errorID); }
    }

    private function set(label:String, index:int, wrap:String, filter:String, mip:String):void {
      try { context.setSamplerStateAt(index, wrap, filter, mip); trace("samplerstates", label, "accepted"); }
      catch (error:Error) { trace("samplerstates", label, error.name, error.errorID); }
    }

    private function run():void {
      texture = context.createTexture(16, 8, "bgra", false);
      context.setTextureAt(0, texture);
      var colors:Array = [0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffff00, 0xff00ffff];
      for (var i:int = 0; i < 5; i++) {
        var bitmap:BitmapData = new BitmapData(Math.max(1, 16 >> i), Math.max(1, 8 >> i), true, colors[i]);
        if (i == 0) {
          for (var y:int = 0; y < 8; y++) {
            for (var x:int = 0; x < 16; x++) {
              bitmap.setPixel32(x, y, y < 4 ? (x < 8 ? 0xffff0000 : 0xff00ff00) : (x < 8 ? 0xff0000ff : 0xffffffff));
            }
          }
        }
        texture.uploadFromBitmapData(bitmap, i);
        bitmap.dispose();
      }
      var ignored:Program3D = program(0x00040000);
      context.setProgram(ignored); draw("default"); draw("default-magnify", 1);
      var plain:Program3D = program(0);
      var mip:Program3D = program(0x01000000);
      draw("inactive-upload");
      set("manual", 0, "repeat", "nearest", "mipnearest"); draw("manual-draw");
      context.setProgram(ignored); draw("same-ignore");
      context.setProgram(plain); draw("plain");
      set("override", 0, "repeat", "nearest", "mipnearest"); draw("override-draw");
      context.setProgram(plain); draw("same-plain");
      context.setProgram(mip); draw("mip");
      context.setProgram(ignored); draw("retain");
      context.present(); draw("present");
      context.configureBackBuffer(64, 64, 0, false); draw("configure");
      var wraps:Array = ["clamp", "repeat", "clamp_u_repeat_v", "repeat_u_clamp_v"];
      var filters:Array = ["nearest", "linear"];
      var mips:Array = ["mipnone", "mipnearest", "miplinear"];
      for (var w:int = 0; w < wraps.length; w++) {
        for (var f:int = 0; f < filters.length; f++) {
          for (var m:int = 0; m < mips.length; m++) {
            var label:String = w + "-" + f + "-" + m;
            set("set-" + label, 0, wraps[w], filters[f], mips[m]);
            draw("magnify-" + label, 1);
            draw("minify-" + label, 8);
            draw("deep-minify-" + label, 16);
            if (m != 2) { draw("fractional-nearest-" + label, 6); }
          }
        }
      }
      context.setTextureAt(0, null);
      context.setTextureAt(0, texture); draw("rebind-retain");
      var pair:Program3D = program(0, 0, true);
      context.setTextureAt(1, texture);
      context.setProgram(pair); draw("conflicting");
      set("unify", 1, "clamp", "nearest", "mipnone"); draw("unified");
      set("conflict", 0, "clamp", "linear", "mipnone"); draw("manual-conflict");
      set("match", 1, "clamp", "linear", "mipnone"); draw("manual-match");
      context.setTextureAt(1, null);
      context.setProgram(ignored);
      var base:Texture = context.createTexture(16, 8, "bgra", false);
      bitmap = new BitmapData(16, 8, true, 0xffff00ff);
      base.uploadFromBitmapData(bitmap); bitmap.dispose();
      context.setTextureAt(0, base);
      set("base-none", 0,"repeat","nearest","mipnone"); draw("base-none");
      set("base-mips", 0,"repeat","nearest","mipnearest"); draw("base-missing");
      context.setTextureAt(0, texture); base.dispose();
      set("slot7-before", 7,"repeat","nearest","mipnearest");
      var seven:Program3D = program(0x00040000, 7);
      context.setTextureAt(0, null); context.setTextureAt(7, texture);
      context.setProgram(seven); draw("slot7");
      context.setTextureAt(7, null); context.setTextureAt(0, texture);
      context.setProgram(ignored); draw("slot0-retained");
      pixels.dispose(); pixels = new BitmapData(128, 128, true, 0);
      context.configureBackBuffer(128, 128, 0, false); draw("resize-retain");
      context.configureBackBuffer(64, 64, 0, false);
      pixels.dispose(); pixels = new BitmapData(64, 64, true, 0);
      var cube:CubeTexture = context.createCubeTexture(8, "bgra", false);
      for (i = 0; i < 4; i++) {
        bitmap = new BitmapData(8 >> i, 8 >> i, true, i == 0 ? 0xff0080ff : 0xff00ff00);
        for (var face:int = 0; face < 6; face++) { cube.uploadFromBitmapData(bitmap, face, i); }
        bitmap.dispose();
      }
      var cubeProgram:Program3D = program(0x41000);
      context.setTextureAt(0, cube); context.setProgram(cubeProgram);
      set("cube-nearest", 0,"clamp","nearest","mipnone"); draw("cube-nearest", 1);
      set("cube-linear", 0,"clamp","linear","miplinear"); draw("cube-linear", 1);
      for (w = 1; w < wraps.length; w++) {
        set("cube-wrap-" + w, 0,wraps[w],"nearest","mipnone"); draw("cube-wrap-" + w, 1);
      }
      context.setTextureAt(0, texture); context.setProgram(ignored);
      cube.dispose(); cubeProgram.dispose();
      var cases:Array = [
        [-1,"bad","bad","bad"], [8,"repeat","nearest","mipnone"],
        [0,"bad","bad","bad"], [0,"repeat","bad","bad"], [0,"repeat","nearest","bad"],
        [0,null,"nearest","mipnone"], [0,"repeat",null,"mipnone"], [0,"repeat","nearest",null],
        [7,"clamp_u_repeat_v","linear","miplinear"], [0,"repeat_u_clamp_v","nearest","mipnone"],
        [-1,"repeat","nearest","mipnone"], [16,"repeat","nearest","mipnone"],
        [0,"bad",null,"bad"], [0,"bad","bad",null]
      ];
      for (i = 0; i < cases.length; i++) { set("error-" + i, cases[i][0], cases[i][1], cases[i][2], cases[i][3]); draw("after-error-" + i); }
      context.setProgram(mip);
      var newFragment:ByteArray = header(true);
      emit(newFragment, 3, 0x020f0000, 0xe4000000, 4, 0xe4000000, 1);
      emit(newFragment, 0x28, 0x030f0000, 0xe4000000, 2, 0, 5);
      mip.upload(vertex, newFragment); draw("reupload-selected");
      set("before-ignore-upload", 0,"repeat","nearest","mipnearest");
      newFragment.position = newFragment.length - 4;
      newFragment.writeUnsignedInt(0x40005);
      mip.upload(vertex, newFragment); draw("reupload-ignore");
      set("negative", -1,"repeat","nearest","mipnone");
      set("slot15", 15,"repeat","nearest","mipnone");
      set("slot16", 16,"repeat","nearest","mipnone");
      set("slot31", 31,"repeat","nearest","mipnone");
      plain.dispose(); mip.dispose(); ignored.dispose(); pair.dispose(); seven.dispose();
      context.dispose(false);
      for (i = 0; i < cases.length; i++) { set("disposed-" + i, cases[i][0], cases[i][1], cases[i][2], cases[i][3]); }
      set("disposed-valid",0,"repeat","nearest","mipnone");
    }
  }
}
