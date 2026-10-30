// blendShader as Flash draws it (cases.ts, shaderBlends, for the kernels,
// each bound to a ByteArray subclass): a pixel at a time, where the object
// covers anything, its first input that pixel of what is below and its
// second the object's, coloured, whatever coordinate the kernel samples
// them at, which is (0.5, 0.5) throughout; the result in place of what was
// below, though less than opaque. Parameters are taken as the shader is
// set. A sprite blends its children together, a filter runs before the
// blend, and blendMode set away and back keeps the shader. Then the
// errors adl gives.
package {
  import flash.display.BlendMode;
  import flash.display.Shader;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.filters.BlurFilter;
  import flash.geom.Matrix;

  public class ShaderBlends extends Sprite {
    private var param:Shader;

    public function ShaderBlends() {
      var ground:Shape = new Shape();
      var m:Matrix = new Matrix();
      m.createGradientBox(320, 120);
      ground.graphics.beginGradientFill("linear", [0x000000, 0xff0000], [1, 1], [0, 255], m);
      ground.graphics.drawRect(0, 0, 320, 120);
      ground.graphics.beginFill(0x00cc00);
      ground.graphics.drawRect(0, 0, 320, 10);
      addChild(ground);

      var circle:Shape = new Shape();
      circle.graphics.beginFill(0x660000, 0.5);
      circle.graphics.drawCircle(20, 20, 20);
      circle.x = 10.5;
      circle.y = 5.25;
      addChild(circle);
      circle.blendShader = new Shader(new OrderKernel());
      trace("mode", circle.blendMode);

      rect(0x330000, 1, 60, 0, 30, 30).blendShader = new Shader(new CoordKernel());
      rect(0x330000, 1, 100, 20, 30, 30).blendShader = new Shader(new HalfKernel());
      var scaled:Shape = rect(0x330000, 1, 140, 20, 10, 10);
      scaled.scaleX = 3;
      scaled.scaleY = 2;
      scaled.blendShader = new Shader(new CoordKernel());

      var group:Sprite = new Sprite();
      group.x = 10;
      group.y = 60;
      addChild(group);
      var a:Shape = new Shape();
      a.graphics.beginFill(0x660000);
      a.graphics.drawRect(0, 0, 20, 20);
      group.addChild(a);
      var b:Shape = new Shape();
      b.graphics.beginFill(0x990000);
      b.graphics.drawRect(10, 10, 20, 20);
      group.addChild(b);
      group.blendShader = new Shader(new OrderKernel());

      var faint:Shape = rect(0x660000, 1, 60, 60, 20, 20);
      faint.alpha = 0.5;
      faint.blendShader = new Shader(new OrderKernel());
      rect(0x660000, 0, 90, 60, 20, 20).blendShader = new Shader(new OrderKernel());
      var blurred:Shape = rect(0x0000ff, 1, 125, 65, 20, 20);
      blurred.filters = [new BlurFilter(6, 6, 2)];
      blurred.blendShader = new Shader(new OrderKernel());

      param = new Shader(new ParamKernel());
      rect(0x660000, 1, 160, 60, 20, 20).blendShader = param;
      var away:Shape = rect(0x660000, 1, 190, 60, 20, 20);
      away.blendShader = new Shader(new LumaKernel());
      away.blendMode = BlendMode.NORMAL;
      away.blendMode = BlendMode.SHADER;
      var plain:Shape = rect(0x660000, 1, 220, 60, 20, 20);
      plain.blendShader = new Shader(new LumaKernel());
      plain.blendMode = BlendMode.MULTIPLY;
      var none:Shape = rect(0x0066ff, 1, 250, 60, 20, 20);
      none.blendMode = BlendMode.SHADER;
      trace("modes", away.blendMode, plain.blendMode, none.blendMode);

      errors();
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function frame(e:Event):void {
      param.data.color.value = [1, 1, 0, 1];
    }

    private function rect(c:uint, alpha:Number, x:Number, y:Number, w:Number, h:Number):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(c, alpha);
      s.graphics.drawRect(0, 0, w, h);
      s.x = x;
      s.y = y;
      addChild(s);
      return s;
    }

    private function errors():void {
      var tries:Array = [
        ["null", function():void { new Shape().blendShader = null; }],
        ["no kernel", function():void { new Shape().blendShader = new Shader(); }],
        ["one input", function():void { new Shape().blendShader = new Shader(new OneKernel()); }],
        ["third unset", function():void { new Shape().blendShader = new Shader(new ThreeKernel()); }]
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
