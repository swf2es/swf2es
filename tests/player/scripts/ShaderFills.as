// beginShaderFill as Flash draws it (cases.ts, shaderFills, for the kernels,
// each bound to a ByteArray subclass): the kernel's coordinate is the
// pixel's centre in the shape's own space through the matrix's inverse,
// whatever the object's scale and turn or its parent's; a bitmap input is
// sampled clamped to its edges; colours past their alpha composite as they
// are; a colour transform colours the fill. Parameters and images are
// taken as the fill begins. Then the errors adl gives.
package {
  import flash.display.BitmapData;
  import flash.display.Shader;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.ColorTransform;
  import flash.geom.Matrix;

  public class ShaderFills extends Sprite {
    private var later:Shader;

    public function ShaderFills() {
      fill(10, 10, new Shader(new CoordKernel()), null);
      fill(70, 10, new Shader(new CoordKernel()), new Matrix(1, 0, 0, 1, 5, 3));
      fill(130, 10, new Shader(new CoordKernel()), new Matrix(2, 0, 0, 2, 0, 0));
      var scaled:Shape = fill(190, 10, new Shader(new CoordKernel()), null, 20, 20);
      scaled.scaleX = scaled.scaleY = 2;
      var m:Matrix = new Matrix();
      m.rotate(Math.PI / 6);
      m.translate(20, 0);
      // Turned, adl's coordinates lie a fifth of a pixel off the pixel's centre: smooth ones show it least.
      fill(250, 10, new Shader(new SmoothKernel()), m);

      var bitmap:BitmapData = new BitmapData(4, 4, false, 0xff0000);
      bitmap.setPixel(1, 0, 0x0000ff);
      bitmap.setPixel(2, 3, 0x00ff00);
      var image:Shader = new Shader(new ImageKernel());
      image.data.src.input = bitmap;
      fill(10, 60, image, new Matrix(5, 0, 0, 5, 5, 5));
      // The pixels as they were when the fill began.
      bitmap.fillRect(bitmap.rect, 0xffff00);
      fill(70, 60, new Shader(new HalfKernel()), null);
      fill(130, 60, new Shader(new OverKernel()), null);
      var tinted:Shape = fill(190, 60, new Shader(new CoordKernel()), null);
      tinted.transform.colorTransform = new ColorTransform(0.5, 1, 1, 0.75, 40, 0, 0, 0);

      var parent:Sprite = new Sprite();
      parent.x = 250;
      parent.y = 60;
      parent.scaleX = 2;
      parent.rotation = 10;
      addChild(parent);
      var child:Shape = new Shape();
      child.graphics.beginShaderFill(new Shader(new SmoothKernel()));
      child.graphics.drawCircle(10, 15, 15);
      parent.addChild(child);

      later = new Shader(new TintKernel());
      fill(10, 110, later, null);
      var triangles:Shape = new Shape();
      triangles.graphics.beginShaderFill(new Shader(new CoordKernel()));
      triangles.graphics.drawTriangles(Vector.<Number>([0, 0, 40, 0, 20, 40, 40, 0, 60, 40, 20, 40]));
      triangles.x = 70;
      triangles.y = 110;
      addChild(triangles);

      errors();
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function frame(e:Event):void {
      later.data.color.value = [1, 0, 0, 1];
    }

    private function fill(x:Number, y:Number, shader:Shader, m:Matrix, w:Number = 40, h:Number = 40):Shape {
      var s:Shape = new Shape();
      s.graphics.beginShaderFill(shader, m);
      s.graphics.drawRect(0, 0, w, h);
      s.graphics.endFill();
      s.x = x;
      s.y = y;
      addChild(s);
      return s;
    }

    private function errors():void {
      var tries:Array = [
        ["null", function():void { new Shape().graphics.beginShaderFill(null); }],
        ["no kernel", function():void { new Shape().graphics.beginShaderFill(new Shader()); }],
        ["unset", function():void { new Shape().graphics.beginShaderFill(new Shader(new ImageKernel())); }],
        ["line null", function():void { new Shape().graphics.lineShaderStyle(null); }],
        ["line unset", function():void { new Shape().graphics.lineShaderStyle(new Shader(new ImageKernel())); }]
      ];
      for each (var t:Array in tries) {
        try {
          t[1]();
          trace(t[0], "ok");
        } catch (e:Error) {
          trace(t[0], e.errorID);
        }
      }
    }
  }
}
