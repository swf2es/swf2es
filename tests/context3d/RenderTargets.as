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
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  public class RenderTargets extends Sprite {
    public var complete:Boolean = false;
    private var c:Context3D;
    private var v:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var solid:Program3D;
    private var sampled:Program3D;
    private var mip:Program3D;
    private var pixels:BitmapData;

    public function RenderTargets() {
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
        trace("rendertargets complete");
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
        emit(fragment, 0x28, 0x030f0000, 0xe4000000, 4, 0, mips ? 0x01000005 : 5);
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
      trace("rendertargets", label, pixels.getPixel32(8,8).toString(16),
        pixels.getPixel32(56,8).toString(16), pixels.getPixel32(8,56).toString(16),
        pixels.getPixel32(56,56).toString(16), pixels.getPixel32(32,32).toString(16));
    }

    private function show(t:Texture, label:String, useMip:Boolean = false):void {
      c.setVertexBufferAt(1, v, 4, "float2");
      c.setRenderToBackBuffer(); c.setScissorRectangle(null); c.setDepthTest(false,"always");
      c.clear(0,0,0,1); c.setTextureAt(0,t); c.setProgram(useMip ? mip : sampled);
      c.drawTriangles(indices); sample(label); c.setTextureAt(0,null);
    }

    private function run():void {
      var t:Texture = c.createTexture(32,16,"bgra",true);
      var other:Texture = c.createTexture(64,64,"bgra",false);
      c.clear(0,0,1,1);
      c.setRenderToTexture(t);
      c.clear(0,1,0,1);
      c.setScissorRectangle(new Rectangle(0,0,16,8)); fill(1,0,0);
      c.setScissorRectangle(null);
      c.setRenderToBackBuffer(); sample("back-preserved");
      show(t,"orientation"); show(t,"mipmaps",true);
      c.setRenderToTexture(t); c.setScissorRectangle(new Rectangle(16,8,16,8)); fill(0,0,1);
      show(t,"retained");
      c.setRenderToTexture(other,true); c.setDepthTest(true,"less"); c.clear(0,0,1,1);
      fill(1,0,0); fill(0,1,0); sample("target-read");
      c.setRenderToBackBuffer(); c.setRenderToTexture(other,true); fill(0,1,0);
      show(other,"depth-retained");
      c.setRenderToTexture(other,false); c.setDepthTest(true,"never"); fill(0,1,0);
      show(other,"depth-disabled");
      c.setRenderToTexture(other); c.clear(64/255,0,0,128/255);
      show(other,"alpha");
      c.setRenderToTexture(t); c.clear(1,1,0,1); c.present(); c.clear(0,0,1,1);
      sample("present-reset"); show(t,"present-retains-texture");
      c.setRenderToTexture(t); c.setRenderToTexture(null); c.clear(1,0,1,1);
      sample("null-reset");
      c.setRenderToTexture(t); c.clear(0,0,1,1);
      c.setCulling("front"); fill(1,0,0); c.setCulling("none");
      show(t,"cull-front");
      c.setRenderToTexture(t); c.clear(0,0,1,1);
      c.setCulling("back"); fill(1,0,0); c.setCulling("none");
      show(t,"cull-back");
      c.setScissorRectangle(new Rectangle(0,0,16,8));
      c.setRenderToTexture(t); c.clear(0,1,0,1); fill(1,0,0);
      show(t,"scissor-switch");
      c.setRenderToTexture(t); c.clear(1,1,0,1);
      var tiny:Texture = c.createTexture(8,8,"bgra",true);
      c.setRenderToTexture(tiny); c.clear(1,0,0,1); fill(1,1,0);
      show(tiny,"small-solid");
      c.setRenderToTexture(tiny); c.clear(0,0,0,1);
      c.setVertexBufferAt(1,v,4,"float2"); c.setTextureAt(0,t); c.setProgram(sampled);
      c.drawTriangles(indices); c.setTextureAt(0,null);
      show(tiny,"small-sampled");
      c.setRenderToTexture(tiny); c.clear(0,0,0,1);
      c.setTextureAt(0,t); c.setProgram(mip); c.drawTriangles(indices); c.setTextureAt(0,null);
      show(tiny,"minified-mips");
      c.setRenderToTexture(other); c.clear(1,1,0,1);
      c.setRenderToTexture(tiny); c.clear(0,0,0,1);
      c.setTextureAt(0,other); c.setProgram(mip); c.drawTriangles(indices); c.setTextureAt(0,null);
      show(tiny,"unoptimized-mips"); tiny.dispose();
      var upload:BitmapData = new BitmapData(32,16,true,0xff0000ff);
      t.uploadFromBitmapData(upload); upload.dispose();
      c.setRenderToTexture(t); c.setScissorRectangle(new Rectangle(0,0,16,8)); fill(1,0,0);
      show(t,"upload-then-render");
      c.setRenderToTexture(t); c.setTextureAt(0,t); c.setProgram(sampled);
      try { c.drawTriangles(indices); trace("rendertargets feedback accepted"); }
      catch (error:Error) { trace("rendertargets feedback",error.errorID); }
      c.setTextureAt(0,null); c.setRenderToBackBuffer();
      t.dispose(); other.dispose();
    }
  }
}
