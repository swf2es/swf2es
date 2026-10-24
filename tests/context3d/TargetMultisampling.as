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
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  public class TargetMultisampling extends Sprite {
    public var complete:Boolean = false;
    private var c:Context3D;
    private var vertices:VertexBuffer3D;
    private var indices:IndexBuffer3D;
    private var solid:Program3D;
    private var sampled:Program3D;
    private var pixels:BitmapData;

    public function TargetMultisampling() {
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
        vertices = c.createVertexBuffer(4, 6);
        vertices.uploadFromVector(Vector.<Number>([
          -1,-1,0.5,1,0,1, 1,-1,0.5,1,1,1,
          -1,1,0.5,1,0,0, 1,1,0.5,1,1,0
        ]), 0, 4);
        indices = c.createIndexBuffer(6);
        indices.uploadFromVector(Vector.<uint>([0,1,2,2,1,3]), 0, 6);
        c.setVertexBufferAt(0, vertices, 0, "float4");
        solid = program(false);
        sampled = program(true);
        pixels = new BitmapData(64,64,true,0);
        run();
        pixels.dispose();
        solid.dispose();
        sampled.dispose();
        vertices.dispose();
        indices.dispose();
        c.dispose(false);
        complete = true;
        trace("targetmultisampling complete");
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

    private function program(texture:Boolean):Program3D {
      var vertex:ByteArray = header(false);
      var fragment:ByteArray = header(true);
      emit(vertex,0,0x030f0000,0xe4000000,0);
      if (texture) {
        emit(vertex,0,0x040f0000,0xe4000001,0);
        emit(fragment,0x28,0x030f0000,0xe4000000,4,0,5);
      } else {
        emit(fragment,0,0x030f0000,0xe4000000,1);
      }
      var result:Program3D = c.createProgram();
      result.upload(vertex,fragment);
      return result;
    }

    private function fill(r:Number,g:Number,b:Number):void {
      c.setVertexBufferAt(1,null);
      c.setProgram(solid);
      c.setProgramConstantsFromVector("fragment",0,Vector.<Number>([r,g,b,1]));
      c.drawTriangles(indices);
    }

    private function sample(label:String):void {
      c.drawToBitmapData(pixels);
      trace("targetmultisampling",label,pixels.getPixel32(8,8).toString(16),
        pixels.getPixel32(56,8).toString(16),pixels.getPixel32(8,56).toString(16),
        pixels.getPixel32(56,56).toString(16),pixels.getPixel32(32,32).toString(16));
    }

    private function show(texture:TextureBase,label:String):void {
      c.setRenderToBackBuffer();
      c.setScissorRectangle(null);
      c.setDepthTest(false,"always");
      c.clear(0,0,0,1);
      c.setVertexBufferAt(1,vertices,4,"float2");
      c.setTextureAt(0,texture);
      c.setProgram(sampled);
      c.drawTriangles(indices);
      sample(label);
      c.setTextureAt(0,null);
    }

    private function probe(label:String,action:Function):void {
      try { action(); trace("targetmultisampling",label,"accepted"); }
      catch (error:Error) { trace("targetmultisampling",label,error.name,error.errorID); }
    }

    private function run():void {
      var target:TextureBase = c.createTexture(32,16,"bgra",true);
      var requests:Array = [-1,0,1,2,4,8,16,17];
      for (var i:int=0;i<requests.length;i++) {
        var quality:int=requests[i];
        probe("quality-"+quality,function():void { c.setRenderToTexture(target,true,quality); });
        c.clear(0,0,1,1);
        c.setDepthTest(false,"always");
        c.setScissorRectangle(new Rectangle(0,0,16,8));
        fill(1,0,0);
        show(target,"pixels-"+quality);
      }
      c.setRenderToTexture(target,true,4);
      c.setDepthTest(false,"always");
      c.clear(0,0,1,1);
      c.setScissorRectangle(new Rectangle(0,0,16,8));
      fill(1,0,0);
      show(target,"retained-start");
      c.setRenderToTexture(target,true,4);
      c.setScissorRectangle(new Rectangle(16,8,16,8));
      fill(0,1,0);
      show(target,"retained-rebind");
      c.setRenderToTexture(target,true,0);
      c.setScissorRectangle(new Rectangle(16,0,16,8));
      fill(1,1,0);
      show(target,"retained-disable-aa");
      c.setRenderToTexture(target,true,4);
      c.setScissorRectangle(new Rectangle(0,8,16,8));
      fill(0,1,1);
      show(target,"retained-enable-aa");
      c.setRenderToTexture(target,true,4);
      c.setScissorRectangle(null);
      c.setDepthTest(true,"less");
      c.clear(0,0,1,1);
      fill(1,0,0);
      show(target,"depth-start");
      c.setRenderToTexture(target,true,4);
      c.setDepthTest(true,"less");
      fill(0,1,0);
      show(target,"depth-rebind");
      c.setRenderToTexture(target,true,0);
      c.setDepthTest(true,"less");
      fill(1,1,0);
      show(target,"depth-disable-aa");
      c.setRenderToTexture(target,true,4);
      c.setDepthTest(true,"less");
      fill(0,1,1);
      show(target,"depth-enable-aa");
      var bitmap:BitmapData = new BitmapData(32,16,true,0xff0000ff);
      Object(target).uploadFromBitmapData(bitmap);
      bitmap.dispose();
      c.setRenderToTexture(target,false,4);
      c.setScissorRectangle(new Rectangle(0,0,16,8));
      fill(1,0,0);
      show(target,"upload-enable-aa");
      var fresh:TextureBase = c.createTexture(32,16,"bgra",true);
      bitmap = new BitmapData(32,16,true,0xff0000ff);
      Object(fresh).uploadFromBitmapData(bitmap);
      bitmap.dispose();
      c.setRenderToTexture(fresh,false,4);
      c.clear(0,0,1,1);
      c.setScissorRectangle(new Rectangle(0,0,16,8));
      fill(1,0,0);
      show(fresh,"first-upload-aa");
      fresh.dispose();
      var rectangle:TextureBase = c.createRectangleTexture(40,24,"bgra",true);
      probe("rectangle-aa",function():void { c.setRenderToTexture(rectangle,false,4); });
      c.clear(0,1,0,1);
      show(rectangle,"rectangle-pixels");
      var cube:TextureBase = c.createCubeTexture(32,"bgra",true);
      probe("cube-aa",function():void { c.setRenderToTexture(cube,true,4,5); });
      c.clear(1,0,1,1);
      c.setRenderToBackBuffer();
      probe("null-aa",function():void { c.setRenderToTexture(null,false,4); });
      target.dispose();
      rectangle.dispose();
      cube.dispose();
    }
  }
}
