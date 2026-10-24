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

  public class CubeTextures extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var texture:CubeTexture;
    private var second:Texture;
    private var pixels:BitmapData;
    private var vertex:ByteArray;

    public function CubeTextures() {
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
        emit(vertex, 3, 0x030f0000, 0xe4000000, 0, 0xe4000003, 1);
        emit(vertex, 0, 0x040f0000, 0xe4000001, 0);
        run();
        vertices.dispose(); indices.dispose(); pixels.dispose(); texture.dispose();
        context.dispose(false);
        complete = true;
        trace("cubetextures complete");
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

    private function draw(label:String, face:int, flags:uint = 0x1000, scale:Number = 1):void {
      var fragment:ByteArray = header(true);
      // Map the interpolated face coordinates to a cube direction.
      emit(fragment, 3, 0x020f0000, 0x00000000, 4, 0xe4000000, 1);
      emit(fragment, 3, 0x020f0001, 0x55000000, 4, 0xe4000001, 1);
      emit(fragment, 1, 0x020f0000, 0xe4000000, 2, 0xe4000001, 2);
      emit(fragment, 1, 0x020f0000, 0xe4000000, 2, 0xe4000002, 1);
      emit(fragment, 0x28, 0x030f0000, 0xe4000000, 2, 0, flags | 5);
      var program:Program3D = context.createProgram();
      program.upload(vertex, fragment);
      context.setProgram(program);
      var axes:Array = [
        [0,0,-2,0, 0,-2,0,0, 1,1,1,0],
        [0,0,2,0, 0,-2,0,0, -1,1,-1,0],
        [2,0,0,0, 0,0,2,0, -1,1,-1,0],
        [2,0,0,0, 0,0,-2,0, -1,-1,1,0],
        [2,0,0,0, 0,-2,0,0, -1,1,1,0],
        [-2,0,0,0, 0,-2,0,0, 1,1,-1,0]
      ];
      context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>(axes[face]));
      context.setProgramConstantsFromVector("vertex", 3, Vector.<Number>([scale, scale, 1, 1]));
      context.clear(0, 0, 0, 1);
      try {
        context.drawTriangles(indices);
        context.drawToBitmapData(pixels);
        trace("cubetextures", label, pixels.getPixel32(16,16).toString(16),
          pixels.getPixel32(48,16).toString(16), pixels.getPixel32(16,48).toString(16),
          pixels.getPixel32(48,48).toString(16), pixels.getPixel32(32,32).toString(16));
      } catch (error:Error) { trace("cubetextures", label, error.name, error.errorID); }
      program.dispose();
    }

    private function upload(face:uint, level:uint):void {
      var colors:Array = [0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffff00, 0xff00ffff, 0xffff00ff];
      var size:int = Math.max(1, 16 >> level);
      var bitmap:BitmapData = new BitmapData(size, size, true, colors[face]);
      if (level === 0) {
        for (var y:int = 0; y < size; y++) {
          for (var x:int = 0; x < size; x++) {
            bitmap.setPixel32(x, y, uint(colors[face]) & (x < 8 ? (y < 8 ? 0xff333333 : 0xff999999) : (y < 8 ? 0xff666666 : 0xffffffff)));
          }
        }
      } else {
        bitmap.fillRect(bitmap.rect, [0,0xff333333,0xff666666,0xff999999,0xffcccccc][level]);
      }
      texture.uploadFromBitmapData(bitmap, face, level);
      bitmap.dispose();
    }

    private function run():void {
      texture = context.createCubeTexture(16, "bgra", false);
      context.setTextureAt(0, texture);
      draw("unuploaded", 0);
      upload(5,0);
      draw("last-face-only",5);
      upload(0,0);
      draw("one-face", 0);
      for (var face:int = 1; face < 6; face++) { upload(face,0); }
      draw("base-only", 0);
      draw("incomplete-mips", 0, 0x01001000);
      for (face = 0; face < 6; face++) {
        for (var level:int = 1; level < 5; level++) { upload(face,level); }
      }
      for (face = 0; face < 6; face++) {
        for (var filter:int = 0; filter < 2; filter++) {
          for (var mip:int = 0; mip < 3; mip++) {
            draw("face"+face+"f"+filter+"m"+mip, face, 0x1000 | (filter << 28) | (mip << 24));
          }
        }
        for (var lod:int = 1; lod <= 3; lod++) {
          draw("minify"+face+"l"+lod, face, 0x01001000, 1 / (4 * Math.pow(2,lod)));
        }
      }
      var one:BitmapData = new BitmapData(1,1,true,0xffffffff);
      try { texture.uploadFromBitmapData(one, 6, 4); trace("cubetextures bad-face accepted"); }
      catch (error:Error) { trace("cubetextures bad-face", error.name, error.errorID); }
      try { texture.uploadFromBitmapData(one, 0, 5); trace("cubetextures bad-level accepted"); }
      catch (error:Error) { trace("cubetextures bad-level", error.name, error.errorID); }
      second = context.createTexture(16,16,"bgra",false);
      var flat:BitmapData = new BitmapData(16,16,true,0xffffffff);
      second.uploadFromBitmapData(flat);
      context.setTextureAt(0,second);
      draw("2d-as-cube",0);
      context.setTextureAt(0,texture);
      draw("cube-as-2d",0,0);
      flat.dispose(); second.dispose();
      var replacement:BitmapData = new BitmapData(16,16,true,0xffabcdef);
      texture.uploadFromBitmapData(replacement,0);
      replacement.dispose();
      draw("reupload",0);
      draw("other-face",1);
      context.present();
      draw("after-present",0);
      texture.dispose();
      texture.uploadFromBitmapData(one,0,4);
      context.setTextureAt(0,texture);
      draw("disposed-rebound",0);
      one.dispose();
    }
  }
}
