package {
  import flash.display.*;

  // What adl does with closing lines where it draws what the page cannot
  // (cases.ts, `line-close-probes`, traced only): drawPath's contours,
  // which adl never closes with a line and fills unclosed, lines back over
  // themselves, and hairlines left of a closing line taken away. The trace
  // reads each cell's pixels at its probes, and the bounds and hit tests.
  public class LineCloseProbes extends Sprite {
    private static const R:uint = 0xff0000;
    private static const B:uint = 0x0000ff;
    private static const K:uint = 0x000000;
    private static const G:uint = 0x00ff00;
    private var shapes:Array = [];

    public function LineCloseProbes() {
      var g:Graphics;
      var n:int = 0;
      var probes:Array = [];
      var bmp:BitmapData = new BitmapData(8, 8, false, B);
      var bmpR:BitmapData = new BitmapData(8, 8, false, R);
      var src:Shape;

      // 0: a drawPath contour left open: no closing line.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.drawPath(Vector.<int>([1, 2, 2]), Vector.<Number>([10, 10, 80, 10, 80, 80]));
      g.endFill();
      probes.push([[45, 45]]);

      // 1: drawPath's change of rule closes the contour before it, its own never.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.drawPath(Vector.<int>([2]), Vector.<Number>([10, 80]), "nonZero");
      g.endFill();
      probes.push([[45, 45], [10, 45], [45, 80], [30, 60]]);

      // 2: a half-transparent line back over itself in a fill: no closing line over it either.
      g = cell(n++);
      g.lineStyle(10, K, 0.5);
      g.beginFill(R);
      g.moveTo(10, 45);
      g.lineTo(80, 45);
      g.lineTo(45, 45);
      g.endFill();
      probes.push([[30, 45]]);

      // 3: the line set after the first edge; bounds and hit tests leave the closing line out.
      g = cell(n++);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineStyle(10, K);
      g.lineTo(80, 80);
      g.endFill();
      probes.push([[45, 45], [41, 47]]);

      // 4: endFill, a line on, then a moveTo: gone for good.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      g.lineTo(10, 80);
      g.moveTo(0, 0);
      probes.push([[45, 45], [45, 80]]);

      // 5: endFill twice, then a line on: gone.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      g.endFill();
      g.lineTo(10, 80);
      probes.push([[45, 45]]);

      // 6: endFill, then a curve on: gone.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      g.curveTo(80, 90, 10, 80);
      probes.push([[40, 40]]);

      // 7: drawPath going on from a lineTo begins a contour of its own.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.drawPath(Vector.<int>([2]), Vector.<Number>([80, 80]));
      g.endFill();
      probes.push([[45, 45], [80, 45]]);

      // 8: a drawPath contour that lineTo goes on with: no closing line.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.drawPath(Vector.<int>([1, 2, 2]), Vector.<Number>([10, 10, 80, 10, 80, 80]));
      g.lineTo(10, 80);
      g.endFill();
      probes.push([[45, 45], [10, 45], [45, 80], [30, 60]]);

      // 9: a drawPath contour ended by a moveTo: none.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.drawPath(Vector.<int>([1, 2, 2]), Vector.<Number>([10, 10, 80, 10, 80, 80]));
      g.moveTo(0, 0);
      g.endFill();
      probes.push([[47, 43]]);

      // 10: a drawPath contour never ended: none.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.drawPath(Vector.<int>([1, 2, 2]), Vector.<Number>([10, 10, 80, 10, 80, 80]));
      probes.push([[47, 43]]);

      // 11: two drawPath contours: none.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.drawPath(Vector.<int>([1, 2, 2, 1, 2, 2]), Vector.<Number>([10, 10, 50, 10, 50, 50, 50, 50, 90, 50, 90, 90]));
      g.endFill();
      probes.push([[32, 28], [72, 68]]);

      // 12: a drawPath contour, then a line style: none.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.drawPath(Vector.<int>([1, 2, 2]), Vector.<Number>([10, 10, 80, 10, 80, 80]));
      g.lineStyle(6, G);
      g.endFill();
      probes.push([[47, 43]]);

      // 13: never ended, the line style taken away and set again green: green.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.lineStyle();
      g.lineStyle(6, G);
      probes.push([[45, 45]]);

      // 14: the line set after the first edge, never ended; bounds and hit tests as 19.
      g = cell(n++);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineStyle(10, K);
      g.lineTo(80, 80);
      probes.push([[45, 45]]);

      // 15: and ended by a moveTo.
      g = cell(n++);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineStyle(10, K);
      g.lineTo(80, 80);
      g.moveTo(80, 80);
      g.endFill();
      probes.push([[45, 45]]);

      var bd:BitmapData = new BitmapData(800, 200, false, 0xffffff);
      bd.draw(this);
      for (var i:int = 0; i < n; i++) {
        var line:String = i + ":";
        for each (var p:Array in probes[i]) {
          line += " " + name(bd.getPixel((i % 8) * 100 + p[0], int(i / 8) * 100 + p[1]));
        }

        trace(line);
      }

      // Bounds, and hit tests just off the closing line, outside the fill.
      for each (var k:int in [3, 14, 15]) {
        var s:Shape = shapes[k];
        trace(k + " " + s.getBounds(s) + " " + s.hitTestPoint(s.x + 41, s.y + 47, true));
      }
    }

    private function name(c:uint):String {
      switch (c) {
        case R:
          return "R";
        case B:
          return "B";
        case K:
          return "K";
        case G:
          return "G";
        case 0xffffff:
          return "w";
      }
      return c.toString(16);
    }

    private function cell(i:int):Graphics {
      var s:Shape = new Shape();
      s.x = (i % 8) * 100;
      s.y = int(i / 8) * 100;
      addChild(s);
      shapes.push(s);
      return s.graphics;
    }
  }
}
