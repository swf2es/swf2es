package {
  import flash.display.GradientType;
  import flash.display.InterpolationMethod;
  import flash.display.Shape;
  import flash.display.SpreadMethod;
  import flash.display.Sprite;
  import flash.geom.Matrix;
  import flash.utils.getQualifiedClassName;

  // Gradient fills (cases.ts, gradients): the timeline's shapes hold a SWF's
  // linear, radial and focal gradients; these are beginGradientFill's, with
  // what it makes of odd arguments.
  public class Gradients extends Sprite {
    public function Gradients() {
      var box:Matrix = new Matrix();
      box.createGradientBox(40, 30, Math.PI / 4, 0, 0);
      fill(5, 45, GradientType.LINEAR, [0xFF0000, 0xFFFF00, 0x0000FF], [1, 1, 1], [0, 100, 255], box, SpreadMethod.REPEAT);

      var radial:Matrix = new Matrix();
      radial.createGradientBox(60, 30);
      fill(75, 45, GradientType.RADIAL, [0xFFFFFF, 0x008040], [1, 1], [0, 255], radial, SpreadMethod.PAD, InterpolationMethod.RGB, -0.5);

      var under:Shape = new Shape();
      under.graphics.beginFill(0x3366CC);
      under.graphics.drawRect(145, 45, 60, 30);
      addChild(under);
      var ramp:Matrix = new Matrix();
      ramp.createGradientBox(60, 30, 0, 145, 45);
      fill(145, 45, GradientType.LINEAR, [0xFF8000, 0xFF8000], [1, 0], [0, 255], ramp);

      var plain:Matrix = new Matrix();
      plain.createGradientBox(60, 30, 0, 5, 85);
      fill(5, 85, GradientType.LINEAR, [0x000000, 0xFFFFFF, 0xFF0000], [1, 1, 1], [0, 200, 100], plain);
      fill(75, 85, GradientType.LINEAR, [], [], [], plain);
      fill(145, 85, GradientType.LINEAR, [0x000000, 0xFFFFFF], [1], [0, 255], plain);

      var lin:Matrix = new Matrix();
      lin.createGradientBox(200, 20, 0, 5, 125);
      fill(5, 125, GradientType.LINEAR, [0xFF0000, 0x0000FF], [1, 1], [0, 255], lin, SpreadMethod.PAD, InterpolationMethod.LINEAR_RGB, 0, 200, 20);

      for each (var odd:Array in [["conic", [0], [1], [0]], ["linear", null, [1], [0]]]) {
        try {
          new Shape().graphics.beginGradientFill(odd[0], odd[1], odd[2], odd[3]);
          trace(odd[0], "ok");
        } catch (e:Error) {
          trace(odd[0], getQualifiedClassName(e), e.errorID);
        }
      }
    }

    private function fill(x:Number, y:Number, type:String, colors:Array, alphas:Array, ratios:Array,
        m:Matrix, spread:String = "pad", interpolation:String = "rgb", focal:Number = 0,
        w:Number = 60, h:Number = 30):void {
      var s:Shape = new Shape();
      s.graphics.beginGradientFill(type, colors, alphas, ratios, m, spread, interpolation, focal);
      s.graphics.drawRect(x, y, w, h);
      addChild(s);
    }
  }
}
