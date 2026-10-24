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
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  public class CubeTargets extends Sprite {
    public var complete:Boolean = false;
    private var c:Context3D;
    private var v:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var solid:Program3D;
    private var sampled:Program3D;
    private var mip:Program3D;
    private var pixels:BitmapData;

    public function CubeTargets() {
      if (stage) { start(); }
      else { addEventListener(Event.ADDED_TO_STAGE, start); }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      var slot:Stage3D = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        c = slot.context3D;
        c.enableErrorChecking = true;
        c.configureBackBuffer(64, 64, 0, true);
        v = c.createVertexBuffer(4, 6);
        v.uploadFromVector(Vector.<Number>([
          -1,-1,0.5,1, 0,1,  1,-1,0.5,1, 1,1,
          -1,1,0.5,1, 0,0,  1,1,0.5,1, 1,0]), 0, 4);
        indices = c.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0,1,2, 2,1,3]), 0, 6);
        c.setVertexBufferAt(0, v, 0, "float4");
        c.setVertexBufferAt(1, v, 4, "float2");
        solid = program(false, false);
        sampled = program(true, false);
        mip = program(true, true);
        pixels = new BitmapData(64,64,true,0);
        run();
        pixels.dispose(); solid.dispose(); sampled.dispose(); mip.dispose();
        v.dispose(); indices.dispose(); c.dispose(false);
        complete = true;
        trace("cubetargets complete");
      });
      slot.requestContext3D("auto", "baseline");
    }

    private function header(fragment:Boolean):ByteArray {
      var b:ByteArray = new ByteArray(); b.endian = "littleEndian";
      b.writeByte(0xa0); b.writeUnsignedInt(1); b.writeByte(0xa1); b.writeByte(fragment ? 1 : 0);
      return b;
    }

    private function emit(b:ByteArray, op:uint, dest:uint, a:uint, at:uint, source:uint = 0, st:uint = 0):void {
      b.writeUnsignedInt(op); b.writeUnsignedInt(dest); b.writeUnsignedInt(a);
      b.writeUnsignedInt(at); b.writeUnsignedInt(source); b.writeUnsignedInt(st);
    }

    private function program(texture:Boolean, mips:Boolean):Program3D {
      var vertex:ByteArray = header(false), fragment:ByteArray = header(true);
      emit(vertex, 0, 0x030f0000, 0xe4000000, 0);
      if (texture) {
        emit(vertex, 0, 0x040f0000, 0xe4000001, 0);
        emit(fragment, 3, 0x020f0000, 0x00000000, 4, 0xe4000000, 1);
        emit(fragment, 3, 0x020f0001, 0x55000000, 4, 0xe4000001, 1);
        emit(fragment, 1, 0x020f0000, 0xe4000000, 2, 0xe4000001, 2);
        emit(fragment, 1, 0x020f0000, 0xe4000000, 2, 0xe4000002, 1);
        emit(fragment, 0x28, 0x030f0000, 0xe4000000, 2, 0, mips ? 0x01001005 : 0x1005);
      } else { emit(fragment, 0, 0x030f0000, 0xe4000000, 1); }
      var p:Program3D = c.createProgram(); p.upload(vertex, fragment); return p;
    }

    private function fill(r:Number, g:Number, b:Number, a:Number = 1):void {
      c.setVertexBufferAt(1, null);
      c.setProgram(solid);
      c.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([r,g,b,a]));
      c.drawTriangles(indices);
    }

    private function sample(label:String):void {
      c.drawToBitmapData(pixels);
      trace("cubetargets", label, pixels.getPixel32(8,8).toString(16),
        pixels.getPixel32(56,8).toString(16), pixels.getPixel32(8,56).toString(16),
        pixels.getPixel32(56,56).toString(16), pixels.getPixel32(32,32).toString(16));
    }

    private function probe(label:String, action:Function):void {
      try { action(); trace("cubetargets", label, "accepted"); }
      catch (error:Error) { trace("cubetargets", label, error.name, error.errorID); }
    }

    private function show(t:CubeTexture, face:int, label:String, useMip:Boolean = false):void {
      var axes:Array = [
        [0,0,-2,0, 0,-2,0,0, 1,1,1,0],
        [0,0,2,0, 0,-2,0,0, -1,1,-1,0],
        [2,0,0,0, 0,0,2,0, -1,1,-1,0],
        [2,0,0,0, 0,0,-2,0, -1,-1,1,0],
        [2,0,0,0, 0,-2,0,0, -1,1,1,0],
        [-2,0,0,0, 0,-2,0,0, 1,1,-1,0]
      ];
      c.setRenderToBackBuffer(); c.setScissorRectangle(null); c.setDepthTest(false,"always");
      c.setStencilActions();
      c.setVertexBufferAt(1, v, 4, "float2");
      c.setProgramConstantsFromVector("fragment", 0, Vector.<Number>(axes[face]));
      c.clear(0,0,0,1); c.setTextureAt(0,t); c.setProgram(useMip ? mip : sampled);
      try { c.drawTriangles(indices); sample(label); }
      catch (error:Error) { trace("cubetargets", label, error.name, error.errorID); }
      c.setTextureAt(0,null);
    }

    private function run():void {
      var t:CubeTexture = c.createCubeTexture(32,"bgra",true);
      var other:CubeTexture = c.createCubeTexture(32,"bgra",false);
      var flat:Texture = c.createTexture(32,32,"bgra",true);
      c.clear(0,0,1,1);
      for (var face:int = 0; face < 6; face++) {
        c.setRenderToTexture(t,false,0,face);
        probe("fresh-read-"+face, function():void { c.drawToBitmapData(pixels); });
        c.clear(0,1,0,1);
        c.setScissorRectangle(new Rectangle(0,0,16,16)); fill(1,0,0);
        c.setScissorRectangle(new Rectangle(16,16,16,16)); fill(0,0,1);
        c.setScissorRectangle(null);
        show(t,face,"partial-"+face);
      }
      for (face = 0; face < 6; face++) {
        show(t,face,"orientation-"+face);
        show(t,face,"mip-"+face,true);
      }
      c.setRenderToTexture(t,false,0,2); c.clear(1,1,0,1);
      for (face = 0; face < 6; face++) { show(t,face,"retained-"+face); }
      // Depth and stencil must be tested across faces, not just across textures.
      c.setRenderToTexture(t,true,0,0); c.setDepthTest(true,"less"); c.clear(0,0,1,1);
      fill(1,0,0);
      c.setRenderToTexture(t,true,0,1); c.clear(0,0,1,1,1,0,1); fill(0,1,0);
      c.setRenderToTexture(t,true,0,0); fill(1,1,0);
      show(t,0,"depth-face0"); show(t,1,"depth-face1");
      c.setRenderToTexture(t,true,0,1); c.clear(0,0,0,1,1,0,2);
      c.setRenderToTexture(t,true,0,0); c.setDepthTest(true,"less"); fill(0,1,0);
      show(t,0,"depth-other-face-clear");
      c.setRenderToTexture(t,true,0,0); c.setDepthTest(false,"always"); c.clear(0,0,1,1,1,7);
      c.setRenderToTexture(t,true,0,1); c.clear(0,0,1,1,1,0,1);
      c.setStencilActions("frontAndBack","equal"); c.setStencilReferenceValue(7); fill(1,0,0);
      show(t,1,"stencil-other-face");
      c.setRenderToTexture(t,false,0,1); c.setDepthTest(true,"never");
      c.setStencilActions("frontAndBack","never"); fill(0,1,0);
      show(t,1,"depth-stencil-disabled");
      c.setRenderToTexture(t,true,0,1); c.setDepthTest(false,"always");
      c.setStencilActions("frontAndBack","equal"); c.setStencilReferenceValue(7); fill(1,1,0);
      show(t,1,"stencil-retained");
      for (face = 0; face < 6; face++) {
        c.setRenderToTexture(other,false,0,face); c.clear(0,1,1,1);
      }
      show(other,5,"unoptimized"); show(t,1,"different-texture-retained");
      c.setRenderToTexture(flat); c.clear(1,0,1,1);
      c.setRenderToTexture(t,false,0,4); c.clear(1,0,1,1); c.present();
      c.clear(0,0,1,1); sample("present-reset"); show(t,4,"present-retains");
      c.setRenderToTexture(t,false,0,5); c.setRenderToTexture(null,false,0,99);
      c.clear(1,0,1,1); sample("null-reset");
      // Uploading one base face and clearing another distinguish initialization scopes.
      var fresh:CubeTexture = c.createCubeTexture(32,"bgra",true);
      var bitmap:BitmapData = new BitmapData(32,32,true,0xffabcdef);
      fresh.uploadFromBitmapData(bitmap,3);
      for (face = 0; face < 6; face++) {
        c.setRenderToTexture(fresh,false,0,face);
        probe("upload-read-"+face, function():void { c.drawToBitmapData(pixels); });
      }
      fresh.uploadFromBitmapData(bitmap,0);
      c.setRenderToTexture(fresh,false,0,0);
      probe("upload-zero-read", function():void { c.drawToBitmapData(pixels); });
      var bytes:ByteArray = new ByteArray();
      for (var bytePixel:int = 0; bytePixel < 32*32; bytePixel++) { bytes.writeUnsignedInt(0xffffffff); }
      fresh.uploadFromByteArray(bytes,0,4);
      c.setRenderToTexture(fresh,false,0,4);
      probe("byte-upload-read", function():void { c.drawToBitmapData(pixels); });
      c.clear(0,0,0,1,1,0,0);
      c.setRenderToTexture(fresh,false,0,5);
      probe("zero-clear-other-face", function():void { c.drawToBitmapData(pixels); });
      bitmap.dispose(); fresh.dispose(); c.setRenderToBackBuffer();
      // Rendering one face must preserve uploaded mipmaps on other faces.
      var mipCube:CubeTexture = c.createCubeTexture(32,"bgra",true);
      for (face = 0; face < 6; face++) {
        for (var level:int = 0; level < 6; level++) {
          bitmap = new BitmapData(32 >> level,32 >> level,true,level == 0 ? 0xffff0000 : 0xff00ff00);
          mipCube.uploadFromBitmapData(bitmap,face,level); bitmap.dispose();
        }
      }
      var small:Texture = c.createTexture(8,8,"bgra",true);
      for (var pass:int = 0; pass < 3; pass++) {
        if (pass == 1) { c.setRenderToTexture(mipCube,false,0,0); c.clear(0,0,1,1); }
        c.setRenderToTexture(small); c.clear(0,0,0,1);
        c.setVertexBufferAt(1, v, 4, "float2"); c.setProgram(mip);
        c.setTextureAt(0,mipCube);
        c.setProgramConstantsFromVector("fragment",0, pass == 2
          ? Vector.<Number>([0,0,-2,0, 0,-2,0,0, 1,1,1,0])
          : Vector.<Number>([0,0,2,0, 0,-2,0,0, -1,1,-1,0]));
        c.drawTriangles(indices); c.setTextureAt(0,null);
        // The 2D output is sampled through a temporary plain 2D program.
        var vs:ByteArray = header(false), fs:ByteArray = header(true);
        emit(vs,0,0x030f0000,0xe4000000,0); emit(vs,0,0x040f0000,0xe4000001,0);
        emit(fs,0x28,0x030f0000,0xe4000000,4,0,5);
        var plain:Program3D = c.createProgram(); plain.upload(vs,fs);
        c.setRenderToBackBuffer(); c.clear(0,0,0,1); c.setProgram(plain); c.setTextureAt(0,small);
        c.drawTriangles(indices); sample("other-face-mips-"+pass); c.setTextureAt(0,null); plain.dispose();
      }
      small.dispose(); mipCube.dispose();
      c.setRenderToTexture(t,false,0,0); c.setTextureAt(0,t); c.setProgram(sampled);
      probe("feedback", function():void { c.drawTriangles(indices); });
      c.setTextureAt(0,null);
      var invalids:Array = [-1,6,99];
      for (var i:int = 0; i < invalids.length; i++) {
        var invalid:int = invalids[i];
        probe("cube-surface-"+invalid,function():void { c.setRenderToTexture(t,false,0,invalid); });
        probe("flat-surface-"+invalid,function():void { c.setRenderToTexture(flat,false,0,invalid); });
      }
      t.dispose();
      c.setRenderToTexture(other,false,0,2); c.clear(0,1,1,1);
      probe("disposed-target",function():void { c.setRenderToTexture(t,false,0,0); });
      probe("disposed-bad-surface",function():void { c.setRenderToTexture(t,false,0,6); });
      fill(1,1,0); show(other,2,"disposed-target-retains");
      other.dispose(); flat.dispose();
    }
  }
}
