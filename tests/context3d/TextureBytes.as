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

  public class TextureBytes extends Sprite {
    public var complete:Boolean = false;
    private var context:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var texture:Texture;
    private var cube:CubeTexture;
    private var pixels:BitmapData;
    private var vertex:ByteArray;

    public function TextureBytes() {
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
        vertices.dispose(); indices.dispose(); pixels.dispose();
        texture.dispose(); cube.dispose(); context.dispose(false);
        complete = true;
        trace("texturebytes complete");
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

    private function capture(label:String, cubeFace:int = -1, scale:Number = 1, opaque:Boolean = false):void {
      var fragment:ByteArray = header(true);
      if (cubeFace < 0) {
        emit(fragment, 3, 0x020f0000, 0xe4000000, 4, 0xe4000000, 1);
        emit(fragment, 0x28, 0x020f0001, 0xe4000000, 2, 0, scale == 1 ? 5 : 0x01000005);
      } else {
        var direction:Array = [[1,0,0,1], [-1,0,0,1], [0,1,0,1], [0,-1,0,1], [0,0,1,1], [0,0,-1,1]][cubeFace];
        context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>(direction));
        emit(fragment, 0x28, 0x020f0001, 0xe4000000, 1, 0, 0x1005);
      }
      if (opaque) { emit(fragment, 0, 0x02080001, 0xe4000001, 1); }
      emit(fragment, 0, 0x030f0000, 0xe4000001, 2);
      var program:Program3D = context.createProgram();
      program.upload(vertex, fragment);
      context.setProgram(program);
      if (cubeFace < 0) { context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([scale, scale, 0, 1])); }
      context.setProgramConstantsFromVector("fragment", 1, Vector.<Number>([0, 0, 0, 1]));
      context.clear(0, 0, 0, 1);
      try {
        context.drawTriangles(indices);
        context.drawToBitmapData(pixels);
        trace("texturebytes", label, pixels.getPixel32(16, 16).toString(16), pixels.getPixel32(48, 16).toString(16),
          pixels.getPixel32(16, 48).toString(16), pixels.getPixel32(48, 48).toString(16));
      } catch (error:Error) { trace("texturebytes", label, error.name, error.errorID); }
      program.dispose();
    }

    private function probe(label:String, action:Function):void {
      try { action(); trace("texturebytes", label, "accepted"); }
      catch (error:Error) { trace("texturebytes", label, error.name, error.errorID); }
    }

    private function dataFor(colors:Array, count:int, offset:int = 0):ByteArray {
      var data:ByteArray = new ByteArray();
      data.endian = "littleEndian";
      for (var i:int = 0; i < offset; i++) { data.writeByte(0xa5); }
      for (i = 0; i < count; i++) { data.writeUnsignedInt(colors[i % colors.length]); }
      return data;
    }

    private function errors(label:String, data:ByteArray):void {
      var offsets:Array = [0, 1, data.length, -1];
      var levels:Array = [0, 1, 2, -1];
      for (var o:int = 0; o < offsets.length; o++) {
        for (var l:int = 0; l < levels.length; l++) {
          var name:String = label + "-offset" + offsets[o] + "-level" + levels[l];
          probe(name, function():void { texture.uploadFromByteArray(data, offsets[o], levels[l]); });
          probe(name + "-null", function():void { texture.uploadFromByteArray(null, offsets[o], levels[l]); });
        }
      }
      var faces:Array = [0, 5, 6, -1];
      for (var f:int = 0; f < faces.length; f++) {
        for (l = 0; l < levels.length; l++) {
          name = label + "-face" + faces[f] + "-level" + levels[l];
          probe(name, function():void { cube.uploadFromByteArray(data, 0, faces[f], levels[l]); });
          probe(name + "-empty", function():void { cube.uploadFromByteArray(new ByteArray(), 0, faces[f], levels[l]); });
          probe(name + "-null", function():void { cube.uploadFromByteArray(null, -1, faces[f], levels[l]); });
        }
      }
    }

    private function run():void {
      texture = context.createTexture(2, 2, "bgra", false);
      context.setTextureAt(0, texture);
      var colors:Array = [0xff123456, 0xffabcdef, 0xff386ca0, 0xfffedcba];
      for (var offset:int = 0; offset < 8; offset++) {
        for (var endian:int = 0; endian < 2; endian++) {
          var data:ByteArray = dataFor(colors, 4, offset);
          data.endian = endian ? "bigEndian" : "littleEndian";
          data.position = 3;
          texture.uploadFromByteArray(data, offset);
          trace("texturebytes source", offset, data.position, data.length, data.endian);
          capture("offset" + offset + "-endian" + endian);
          data.clear();
          capture("source-cleared" + offset + "-endian" + endian);
        }
      }
      data = dataFor([0x80204060, 0x804080c0, 0x00123456, 0xffabcdef], 4, 1);
      texture.uploadFromByteArray(data, 1);
      capture("alpha"); capture("raw-rgb", -1, 1, true);
      var bitmap:BitmapData = new BitmapData(2, 2, true, 0x804080c0);
      texture.uploadFromBitmapData(bitmap);
      capture("bitmap-after-bytes");
      texture.uploadFromByteArray(data, 1);
      capture("bytes-after-bitmap");
      bitmap.dispose();
      data.length = 16;
      probe("short", function():void { texture.uploadFromByteArray(data, 1); });
      capture("failed-preserves");
      texture.dispose();

      texture = context.createTexture(16, 8, "bgra", false);
      context.setTextureAt(0, texture);
      colors = [0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffff00, 0xff00ffff];
      for (var level:int = 0; level < 5; level++) {
        data = dataFor([colors[level]], Math.max(1, 16 >> level) * Math.max(1, 8 >> level), 3);
        texture.uploadFromByteArray(data, 3, level);
        data.clear();
      }
      for (level = 0; level < 5; level++) { capture("mip" + level, -1, 4 * Math.pow(2, level)); }
      data = dataFor([0xffff00ff], 32, 1);
      texture.uploadFromByteArray(data, 1, 1);
      capture("replace-mip1", -1, 8);
      capture("preserve-mip2", -1, 16);
      texture.dispose();

      // Only a successful base-level upload initializes a render target.
      texture = context.createTexture(8, 8, "bgra", true);
      context.setTextureAt(0, null);
      context.setRenderToTexture(texture);
      probe("target-empty", function():void { context.drawToBitmapData(pixels); });
      data = dataFor([0xffff0000], 16, 1);
      texture.uploadFromByteArray(data, 1, 1);
      probe("target-mip-only", function():void { context.drawToBitmapData(pixels); });
      probe("target-short-upload", function():void { texture.uploadFromByteArray(data, 1); });
      probe("target-after-short", function():void { context.drawToBitmapData(pixels); });
      data = dataFor([0xff123456], 64, 1);
      texture.uploadFromByteArray(data, 1);
      probe("target-base-upload", function():void { context.drawToBitmapData(pixels); });
      context.setRenderToBackBuffer(); context.setTextureAt(0, texture);
      capture("target-upload-pixels");
      texture.dispose();

      cube = context.createCubeTexture(2, "bgra", false);
      context.setTextureAt(0, cube);
      colors.push(0xffff00ff);
      for (var face:int = 0; face < 6; face++) {
        for (level = 0; level < 2; level++) {
          data = dataFor([colors[(face + level) % 6]], level ? 1 : 4, face);
          cube.uploadFromByteArray(data, face, face, level);
          data.clear();
        }
      }
      for (face = 0; face < 6; face++) { capture("cube-face" + face, face); }
      data = dataFor([0xff123456], 4, 7);
      cube.uploadFromByteArray(data, 7, 3);
      capture("cube-replace", 3); capture("cube-preserve", 4);
      context.setTextureAt(0, null);
      texture = context.createTexture(2, 2, "bgra", false);
      data = dataFor([0xffffffff], 4);
      errors("live", data);
      texture.dispose(); cube.dispose();
      errors("disposed", data);
      var retired:Texture = texture;
      var retiredCube:CubeTexture = cube;
      texture = context.createTexture(2, 2, "bgra", false);
      cube = context.createCubeTexture(2, "bgra", false);
      context.dispose(false);
      errors("owner-disposed", data);
      texture = retired; cube = retiredCube;
      errors("both-disposed", data);
    }
  }
}
