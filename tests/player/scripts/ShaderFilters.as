// ShaderFilter as Flash draws it (cases.ts, shaderFilters, for the kernels,
// each bound to a ByteArray subclass). On display objects: the kernel's
// coordinate is the pixel's centre from the corner of the object's bitmap,
// in stage pixels whatever the object's scale or turn, the extensions grow
// the bitmap round it, its first input is the object, transparent past its
// edges, nearest or linear, and its other inputs clamp to theirs, even for
// an object hanging off the stage's corner; a blur
// before it grows what it reads, and a glow after it runs on what it made;
// its parameters and images are taken as the filters are set, so a change
// after shows only once they are set again. Through applyFilter: the
// kernel's coordinate is the destination's, moved back by the left and top
// extensions, its first input the whole source, and what it writes is the
// source grown by the extensions, from the point less twice the rect's
// corner. Then the errors adl gives.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Shader;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.filters.BlurFilter;
  import flash.filters.GlowFilter;
  import flash.filters.ShaderFilter;
  import flash.geom.Matrix;
  import flash.geom.Point;
  import flash.geom.Rectangle;

  public class ShaderFilters extends Sprite {
    private var tint:Shader;
    private var again:Shader;
    private var againShape:Shape;
    private var frames:int = 0;

    public function ShaderFilters() {
      var coord:ShaderFilter = new ShaderFilter(new Shader(new CoordKernel()));
      box(10.25, 10.5, 40, 30).filters = [coord];
      var grown:ShaderFilter = new ShaderFilter(new Shader(new CoordKernel()));
      grown.leftExtension = 5;
      grown.topExtension = 3;
      grown.rightExtension = 7;
      grown.bottomExtension = 2;
      box(75.5, 10.5, 40, 30).filters = [grown];
      var scaled:Shape = box(135, 10, 20, 15);
      scaled.scaleX = scaled.scaleY = 2;
      scaled.filters = [coord];
      var turned:Shape = box(205, 5, 30, 30);
      turned.rotation = 30;
      turned.filters = [coord];
      box(260, 15, 20, 20).filters = [new BlurFilter(8, 8, 1), coord];
      // Hanging off the stage's top left: the coordinates still from the object's own corner.
      var off:ShaderFilter = new ShaderFilter(new Shader(new CoordKernel()));
      off.rightExtension = 3;
      box(-15.5, -10.25, 40, 30).filters = [new BlurFilter(4, 4, 1), off];

      var shift:ShaderFilter = new ShaderFilter(new Shader(new ShiftKernel()));
      shift.leftExtension = 5;
      box(15, 60, 30, 20).filters = [shift];
      var linear:ShaderFilter = new ShaderFilter(new Shader(new ShiftLinearKernel()));
      linear.leftExtension = 5;
      box(70, 60, 30, 20).filters = [linear];
      var green:BitmapData = new BitmapData(20, 10, false, 0x00cc00);
      green.fillRect(new Rectangle(0, 0, 10, 10), 0x0000cc);
      var two:Shader = new Shader(new TwoKernel());
      two.data.b.input = green;
      box(115, 60, 30, 20).filters = [new ShaderFilter(two)];
      // The input's pixels as they were when the filters were set.
      green.fillRect(green.rect, 0xff00ff);

      tint = new Shader(new TintKernel());
      box(160, 60, 30, 20).filters = [new ShaderFilter(tint)];
      again = new Shader(new TintKernel());
      againShape = box(200, 60, 30, 20);
      againShape.filters = [new ShaderFilter(again)];

      var ring:Shape = new Shape();
      var m:Matrix = new Matrix();
      m.createGradientBox(40, 40);
      ring.graphics.beginGradientFill("linear", [0xff0000, 0x0000ff], [1, 1], [0, 255], m);
      ring.graphics.drawCircle(20, 20, 20);
      ring.graphics.beginFill(0xffffff);
      ring.graphics.drawCircle(20, 20, 8);
      ring.x = 245;
      ring.y = 55;
      ring.filters = [new ShaderFilter(new Shader(new TwirlKernel())), new GlowFilter(0x000000, 1, 4, 4)];
      addChild(ring);

      var over:Shape = box(290, 60, 20, 20);
      over.filters = [new ShaderFilter(new Shader(new OverKernel()))];

      applyFilters();
      errors();
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function frame(e:Event):void {
      if (++frames == 1) {
        tint.data.color.value = [1, 0.5, 0, 1];
        again.data.color.value = [1, 0.5, 0, 1];
        againShape.filters = againShape.filters;
      }
    }

    /** A box, red on its left and blue on its right, the right half translucent. */
    private function box(x:Number, y:Number, w:Number, h:Number):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(0xff0000);
      s.graphics.drawRect(0, 0, w / 2, h);
      s.graphics.beginFill(0x0000ff, 0.6);
      s.graphics.drawRect(w / 2, 0, w / 2, h);
      s.x = x;
      s.y = y;
      addChild(s);
      return s;
    }

    private function applyFilters():void {
      var source:BitmapData = new BitmapData(20, 10, true, 0);
      for (var y:int = 0; y < 10; y++) {
        for (var x:int = 0; x < 20; x++) {
          source.setPixel32(x, y, ((40 + x * 10) << 24) | (y * 25 << 8) | 0xff);
        }
      }

      var shift:ShaderFilter = new ShaderFilter(new Shader(new ShiftKernel()));
      shift.leftExtension = 4;
      shift.topExtension = 1;
      shift.rightExtension = 2;
      shift.bottomExtension = 3;
      trace("rect", source.generateFilterRect(new Rectangle(2, 2, 5, 5), shift));
      var whole:BitmapData = new BitmapData(40, 24, true, 0x40ff0000);
      whole.applyFilter(source, source.rect, new Point(5, 3), shift);
      show(whole, 10, 110, "whole");

      var coord:ShaderFilter = new ShaderFilter(new Shader(new CoordKernel()));
      coord.leftExtension = 2;
      var part:BitmapData = new BitmapData(40, 24, true, 0x40ff0000);
      part.applyFilter(source, new Rectangle(3, 2, 10, 6), new Point(14, 6), coord);
      show(part, 60, 110, "part");

      var opaque:BitmapData = new BitmapData(40, 24, false, 0x336699);
      opaque.applyFilter(source, source.rect, new Point(1.7, 2.2), new ShaderFilter(new Shader(new CoordKernel())));
      show(opaque, 110, 110, "opaque");

      var self:BitmapData = source.clone();
      self.applyFilter(self, self.rect, new Point(0, 0), new ShaderFilter(new Shader(new ShiftLinearKernel())));
      show(self, 160, 110, "self");
    }

    private function show(b:BitmapData, x:Number, y:Number, label:String):void {
      var bitmap:Bitmap = new Bitmap(b);
      bitmap.x = x;
      bitmap.y = y;
      bitmap.scaleX = bitmap.scaleY = 2;
      addChild(bitmap);
      var row:Array = [];
      for (var k:int = 0; k < 24; k += 3) {
        row.push(b.getPixel32(k + 4, k / 2).toString(16));
      }

      trace(label, row.join(" "));
    }

    private function errors():void {
      var tries:Array = [
        ["no kernel", function():void { new ShaderFilter(new Shader()); }],
        ["null shader", function():void { new ShaderFilter().shader = null; }],
        ["negative", function():void { new ShaderFilter().leftExtension = -1; }],
        ["unset filter", function():void { new Shape().filters = [new ShaderFilter()]; }],
        ["no inputs", function():void { new Shape().filters = [new ShaderFilter(new Shader(new SolidKernel()))]; }],
        ["second unset", function():void { new Shape().filters = [new ShaderFilter(new Shader(new TwoKernel()))]; }],
        ["three channels", function():void { new Shape().filters = [new ShaderFilter(new Shader(new RgbKernel()))]; }],
        ["apply unset", function():void {
          new BitmapData(4, 4).applyFilter(new BitmapData(4, 4), new Rectangle(0, 0, 4, 4), new Point(0, 0), new ShaderFilter());
        }]
      ];
      for each (var t:Array in tries) {
        try {
          t[1]();
          trace(t[0], "ok");
        } catch (e:Error) {
          trace(t[0], e.errorID);
        }
      }

      var f:ShaderFilter = new ShaderFilter();
      f.topExtension = 2.7;
      f.bottomExtension = 9;
      trace("extensions", f.leftExtension, f.topExtension, f.rightExtension, f.bottomExtension, f.shader);
      trace("unset rect", new BitmapData(10, 10).generateFilterRect(new Rectangle(0, 0, 1, 1), f));
      var s:Shape = new Shape();
      var shader:Shader = new Shader(new TintKernel());
      s.filters = [new ShaderFilter(shader)];
      trace("read back", s.filters[0] is ShaderFilter, ShaderFilter(s.filters[0]).shader == shader);
    }
  }
}
