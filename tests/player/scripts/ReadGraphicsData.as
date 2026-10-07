package {
  import flash.display.BitmapData;
  import flash.display.GradientType;
  import flash.display.Graphics;
  import flash.display.GraphicsBitmapFill;
  import flash.display.GraphicsEndFill;
  import flash.display.GraphicsGradientFill;
  import flash.display.GraphicsPath;
  import flash.display.GraphicsSolidFill;
  import flash.display.GraphicsStroke;
  import flash.display.IGraphicsData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.geom.Matrix;
  import flash.utils.getQualifiedClassName;

  public class ReadGraphicsData extends Sprite {
    private var bitmap:BitmapData = new BitmapData(4, 3, false, 0x336699);

    public function ReadGraphicsData() {
      probe("empty", function (g:Graphics):void {});
      probe("rect", function (g:Graphics):void {
        g.beginFill(0xff0000, 0.5);
        g.drawRect(10, 20, 30, 40);
        g.endFill();
      });
      probe("rect no end", function (g:Graphics):void {
        g.beginFill(0x00ff00);
        g.drawRect(1.33, 2.66, 3.01, 4.5);
      });
      probe("circle", function (g:Graphics):void {
        g.beginFill(0x0000ff);
        g.drawCircle(50, 50, 20);
        g.endFill();
      });
      probe("ellipse", function (g:Graphics):void {
        g.beginFill(0x0000ff);
        g.drawEllipse(10, 10, 40, 20);
      });
      probe("round rect", function (g:Graphics):void {
        g.beginFill(0x123456, 0.25);
        g.drawRoundRect(0, 0, 100, 50, 20, 10);
        g.endFill();
      });
      probe("round rect complex", function (g:Graphics):void {
        g.beginFill(0x123456);
        g.drawRoundRectComplex(0, 0, 100, 50, 5, 10, 0, 20);
        g.endFill();
      });
      probe("line curve", function (g:Graphics):void {
        g.lineStyle(2, 0x00ff00, 0.75);
        g.moveTo(10, 10);
        g.curveTo(20, 0, 30, 10);
        g.lineTo(40, 40);
      });
      probe("line styles", function (g:Graphics):void {
        g.lineStyle(3.5, 0xabcdef, 1, true, "horizontal", "square", "miter", 5);
        g.moveTo(1, 1);
        g.lineTo(5, 9);
        g.lineStyle(0, 0x111111, 0.1, false, "none", "none", "bevel");
        g.lineTo(9, 1);
        g.lineStyle();
        g.lineTo(20, 20);
        g.lineStyle(300, 0x222222);
        g.lineTo(30, 20);
      });
      probe("fill and line", function (g:Graphics):void {
        g.lineStyle(10, 0xff00ff);
        g.beginFill(0xffff00);
        g.drawRect(0, 0, 50, 50);
        g.endFill();
      });
      probe("open contour", function (g:Graphics):void {
        g.beginFill(0xff0000);
        g.moveTo(0, 0);
        g.lineTo(10, 0);
        g.lineTo(10, 10);
        g.endFill();
        g.moveTo(50, 50);
        g.lineTo(60, 60);
      });
      probe("lines only", function (g:Graphics):void {
        g.lineTo(10, 10);
        g.moveTo(5, 5);
      });
      probe("cubic", function (g:Graphics):void {
        g.beginFill(0x00ffff);
        g.moveTo(0, 0);
        g.cubicCurveTo(10, 40, 30, -20, 40, 0);
        g.endFill();
      });
      probe("draw path", function (g:Graphics):void {
        g.beginFill(0x808080);
        g.drawPath(Vector.<int>([1, 2, 2, 2, 4, 5]), Vector.<Number>([0, 0, 10, 0, 10, 10,
          0, 10, 99, 99, 20, 20, 99, 99, 30, 30]), "nonZero");
        g.endFill();
      });
      probe("linear gradient", function (g:Graphics):void {
        var m:Matrix = new Matrix();
        m.createGradientBox(100, 50, Math.PI / 4, 10, 5);
        g.beginGradientFill(GradientType.LINEAR, [0xff0000, 0x0000ff], [1, 0.5], [0, 255], m,
          "reflect", "linearRGB", 0.5);
        g.drawRect(0, 0, 100, 50);
        g.endFill();
      });
      probe("radial gradient", function (g:Graphics):void {
        g.beginGradientFill(GradientType.RADIAL, [0xff0000, 0x00ff00, 0x0000ff], [1, 1, 1],
          [0, 100, 255], null, "repeat", "rgb", -0.75);
        g.drawCircle(0, 0, 10);
      });
      probe("bitmap fill", function (g:Graphics):void {
        g.beginBitmapFill(bitmap, new Matrix(2, 0, 0, 2, 5, 5), false, true);
        g.drawRect(0, 0, 8, 6);
        g.endFill();
        g.beginBitmapFill(bitmap);
        g.drawRect(10, 0, 8, 6);
      });
      probe("cleared", function (g:Graphics):void {
        g.beginFill(0xff0000);
        g.drawRect(0, 0, 10, 10);
        g.clear();
        g.lineStyle(10);
        g.lineTo(30, 40);
      });

      probe("layers", function (g:Graphics):void {
        g.lineStyle(10, 0xff0000);
        g.moveTo(0, 0);
        g.lineTo(100, 0);
        g.beginFill(0x00ff00);
        g.drawRect(0, 0, 50, 50);
        g.endFill();
        g.lineStyle(10, 0x0000ff);
        g.moveTo(0, 100);
        g.lineTo(100, 100);
        g.beginFill(0x00ffff);
        g.drawRect(0, 200, 50, 50);
      });
      probe("two contours", function (g:Graphics):void {
        g.beginFill(0xff0000);
        g.drawRect(0, 0, 50, 50);
        g.drawRect(100, 0, 50, 50);
        g.moveTo(0, 0);
        g.lineTo(10, 0);
        g.lineTo(0, 0);
        g.drawRect(200, 0, 50, 50);
      });
      probe("collinear curve", function (g:Graphics):void {
        g.beginFill(0xff0000);
        g.moveTo(0, 0);
        g.curveTo(10, 0, 20, 0);
        g.curveTo(20, 10.01, 20, 20);
        g.curveTo(10, 20, 0, 20);
        g.curveTo(0, 20, 0, 0);
      });
      probe("small cubic", function (g:Graphics):void {
        g.beginFill(0xff0000);
        g.cubicCurveTo(1, 4, 3, -2, 4, 0);
      });
      probe("big cubic", function (g:Graphics):void {
        g.beginFill(0xff0000);
        g.cubicCurveTo(1000, 4000, 3000, -2000, 4000, 0);
      });
      var sizes:Array = [0.5, 1, 2, 4, 6, 12, 16, 50, 100, 150, 400, 1000];
      for each (var size:Number in sizes) {
        var k:Shape = new Shape();
        k.graphics.beginFill(0);
        k.graphics.cubicCurveTo(size / 4, size, size * 3 / 4, -size / 2, size, 0);
        k.graphics.moveTo(0, 0);
        k.graphics.cubicCurveTo(0, size, size, size, size, 0);
        k.graphics.moveTo(0, 0);
        k.graphics.cubicCurveTo(size, 0, size, 0, size, size);
        trace("cubic", size, GraphicsPath(k.graphics.readGraphicsData()[1]).commands.join(""));
      }

      probe("colors", function (g:Graphics):void {
        g.beginFill(0x123456, 0.1);
        g.drawRect(0, 0, 1, 1);
        g.beginFill(0x89abcd, 0.3);
        g.drawRect(0, 0, 1, 1);
        g.beginFill(0xfedcba, 0.7);
        g.drawRect(0, 0, 1, 1);
        g.beginFill(0xffffff, 0);
        g.drawRect(0, 0, 1, 1);
        g.beginGradientFill("radial", [0x123456, 0x89abcd], [0.1, 0.7], [0, 255], null, "pad",
          "rgb", 0.5);
        g.drawRect(0, 0, 1, 1);
        g.beginGradientFill("radial", [0xfedcba, 0x89abcd], [0.3, 0.003], [10, 20], null, "pad",
          "rgb", -0.3);
        g.drawRect(0, 0, 1, 1);
        g.beginGradientFill("radial", [0xfedcba], [1], [10], new Matrix(1, 2, 3, 4, 5.33, 6.66),
          "pad", "rgb", 1.5);
        g.drawRect(0, 0, 1, 1);
        g.beginGradientFill("linear", [0], [1], [0], new Matrix(0.1234567, 1e-5, 33.3, 1, -1.5,
          2.5));
        g.drawRect(0, 0, 1, 1);
        g.beginBitmapFill(bitmap, new Matrix(0.5, 0.25, -0.125, 3, 1.33, 2.66));
        g.drawRect(0, 0, 1, 1);
        g.beginBitmapFill(bitmap, new Matrix(1.5, 0.25, 0.75, 1, -1.5, 0.6));
        g.drawRect(0, 0, 1, 1);
      });
      probe("line round", function (g:Graphics):void {
        g.lineStyle(10, 0x808080, 0.3);
        g.moveTo(0, 0);
        g.lineTo(100, 0);
      });
      probe("line diagonal", function (g:Graphics):void {
        g.lineStyle(10, 0x808080);
        g.moveTo(10, 20);
        g.lineTo(70, 100);
      });
      probe("polyline round", function (g:Graphics):void {
        g.lineStyle(10, 0x808080);
        g.moveTo(0, 0);
        g.lineTo(100, 0);
        g.lineTo(100, 100);
        g.lineTo(0, 200);
      });
      probe("polyline miter", function (g:Graphics):void {
        g.lineStyle(10, 0x808080, 1, false, "normal", "none", "miter", 3);
        g.moveTo(0, 0);
        g.lineTo(100, 0);
        g.lineTo(100, 100);
        g.lineTo(0, 120);
        g.lineTo(200, 120);
      });
      probe("polyline bevel", function (g:Graphics):void {
        g.lineStyle(10, 0x808080, 1, false, "normal", "square", "bevel");
        g.moveTo(0, 0);
        g.lineTo(100, 0);
        g.lineTo(100, 100);
        g.lineTo(0, 200);
      });
      probe("closed stroke", function (g:Graphics):void {
        g.lineStyle(10, 0x808080);
        g.drawRect(0, 0, 100, 100);
      });
      probe("two strokes", function (g:Graphics):void {
        g.lineStyle(10, 0x808080);
        g.moveTo(0, 0);
        g.lineTo(100, 0);
        g.moveTo(0, 100);
        g.lineTo(100, 100);
        g.lineTo(100, 200);
      });
      probe("stroke reverse turn", function (g:Graphics):void {
        g.lineStyle(10, 0x808080);
        g.moveTo(0, 0);
        g.lineTo(100, 0);
        g.lineTo(100, -100);
      });
      probe("hairline", function (g:Graphics):void {
        g.lineStyle(0, 0x808080);
        g.moveTo(0, 0);
        g.lineTo(100, 0);
        g.lineTo(100, 100);
        g.moveTo(10, 10);
        g.lineTo(13, 50);
      });
      probe("open fill with line", function (g:Graphics):void {
        g.lineStyle(10, 0x808080);
        g.beginFill(0xff0000);
        g.moveTo(0, 0);
        g.lineTo(100, 0);
        g.lineTo(100, 100);
        g.endFill();
      });
      var widths:Array = [0.04, 0.5, 0.75, 1.25, 1.5, 2.5, 3.3, 3.5, 4.5, 5.5, 7.25, 10.5, 254.9];
      for each (var mode:String in ["normal", "none", "vertical"]) {
        var out:Array = [];
        for each (var w:Number in widths) {
          var ws:Shape = new Shape();
          ws.graphics.lineStyle(w, 0, 1, false, mode, "none");
          ws.graphics.moveTo(0, 0);
          ws.graphics.lineTo(0, 100);
          var wp:GraphicsPath = ws.graphics.readGraphicsData()[1] as GraphicsPath;
          out.push(w + ":" + wp.data[0] + "/" + wp.data[4]);
        }

        trace("widths", mode, out.join(" "));
      }

      var parent:Sprite = new Sprite();
      parent.graphics.beginFill(0x111111);
      parent.graphics.drawRect(0, 0, 5, 5);
      var child:Shape = new Shape();
      child.x = 100;
      child.scaleX = 2;
      child.graphics.beginFill(0x222222);
      child.graphics.drawRect(1, 1, 2, 2);
      parent.addChild(child);
      var inner:Sprite = new Sprite();
      inner.graphics.lineStyle(10, 0x333333);
      inner.graphics.lineTo(0, 7);
      parent.addChild(inner);
      var empty:Sprite = new Sprite();
      parent.addChild(empty);
      dump("recurse", parent.graphics.readGraphicsData());
      dump("no recurse", parent.graphics.readGraphicsData(false));
      dump("child", child.graphics.readGraphicsData());

      var drawn:Shape = new Shape();
      drawn.graphics.drawGraphicsData(parent.graphics.readGraphicsData());
      dump("round trip", drawn.graphics.readGraphicsData());
      var v:Vector.<IGraphicsData> = parent.graphics.readGraphicsData();
      trace("same objects", v[0] == parent.graphics.readGraphicsData()[0]);
      var filled:Shape = new Shape();
      filled.graphics.beginBitmapFill(bitmap);
      filled.graphics.drawRect(0, 0, 1, 1);
      for each (var d:IGraphicsData in filled.graphics.readGraphicsData()) {
        if (d is GraphicsBitmapFill) {
          trace("bitmap is same", GraphicsBitmapFill(d).bitmapData == bitmap);
        }
      }
    }

    private function probe(name:String, draw:Function):void {
      var shape:Shape = new Shape();
      draw(shape.graphics);
      dump(name, shape.graphics.readGraphicsData());
    }

    private function dump(name:String, v:Vector.<IGraphicsData>):void {
      trace("==", name, v.length, getQualifiedClassName(v));
      for each (var d:IGraphicsData in v) {
        trace("  " + describe(d));
      }
    }

    private function describe(d:Object):String {
      if (d == null) {
        return "null";
      }

      var name:String = getQualifiedClassName(d).replace("flash.display::", "");
      if (d is GraphicsSolidFill) {
        return name + " " + d.color.toString(16) + " " + d.alpha;
      }

      if (d is GraphicsGradientFill) {
        return name + " " + d.type + " [" + d.colors + "] [" + d.alphas + "] [" + d.ratios + "] " +
          d.matrix + " " + d.spreadMethod + " " + d.interpolationMethod + " " + d.focalPointRatio;
      }

      if (d is GraphicsBitmapFill) {
        return name + " " + (d.bitmapData ? d.bitmapData.width + "x" + d.bitmapData.height : null) +
          " " + d.matrix + " " + d.repeat + " " + d.smooth;
      }

      if (d is GraphicsStroke) {
        return name + " " + d.thickness + " " + d.pixelHinting + " " + d.scaleMode + " " + d.caps +
          " " + d.joints + " " + d.miterLimit + " {" + describe(d.fill) + "}";
      }

      if (d is GraphicsPath) {
        return name + " " + d.winding + " [" + d.commands + "] [" + d.data + "] " +
          getQualifiedClassName(d.commands) + " " + getQualifiedClassName(d.data);
      }

      return name;
    }
  }
}
