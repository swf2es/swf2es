package {
  import flash.display.*;

  // A fill's contour left open is closed with a line in the line style of
  // the time (cases.ts, `line-close`), wherever the contour ends: endFill,
  // the next fill, a moveTo, a drawCircle, or no end at all; with no line
  // style then, or no fill, there is none. A line drawn on from the pen
  // after endFill takes it away again; a move, a line style or a fill keeps
  // it. A contour along one line, with no area, has none, and half-
  // transparent lines show it no darker. The trace reads each cell's pixels
  // at its probes, each name the colour found, and the bounds and hit
  // tests, which leave the closing line out.
  public class LineClose extends Sprite {
    private static const R:uint = 0xff0000;
    private static const B:uint = 0x0000ff;
    private static const K:uint = 0x000000;
    private static const G:uint = 0x00ff00;
    private var shapes:Array = [];

    public function LineClose() {
      var g:Graphics;
      var n:int = 0;
      var probes:Array = [];
      var bmp:BitmapData = new BitmapData(8, 8, false, B);
      var bmpR:BitmapData = new BitmapData(8, 8, false, R);
      var src:Shape;

      // 0: closed by endFill.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      probes.push([[44, 46]]);

      // 1: closed by a moveTo, and the second by endFill.
      g = cell(n++);
      g.beginFill(R);
      g.lineStyle(4, K);
      g.moveTo(10, 10);
      g.lineTo(50, 10);
      g.lineTo(50, 50);
      g.moveTo(60, 60);
      g.lineTo(90, 60);
      g.lineTo(90, 90);
      g.endFill();
      probes.push([[29, 31], [74, 76]]);

      // 2: closed by the next fill.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(50, 10);
      g.lineTo(50, 50);
      g.beginFill(B);
      g.moveTo(60, 60);
      g.lineTo(90, 60);
      g.lineTo(90, 90);
      g.endFill();
      probes.push([[29, 31], [74, 76]]);

      // 3: in the line style set before endFill.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.lineStyle(4, G);
      g.endFill();
      probes.push([[44, 46]]);

      // 4: none with no line style at endFill.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.lineStyle();
      g.endFill();
      probes.push([[44, 46]]);

      // 5: none with no fill.
      g = cell(n++);
      g.lineStyle(4, K);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      probes.push([[44, 46]]);

      // 6: closed with no endFill.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      probes.push([[44, 46]]);

      // 7: the line style changed partway round.
      g = cell(n++);
      g.beginFill(R);
      g.lineStyle(4, K);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineStyle(4, G);
      g.lineTo(80, 80);
      g.lineTo(40, 80);
      g.endFill();
      probes.push([[24, 45]]);

      // 8: the pen where it was after endFill, a green line on from it.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(50, 10);
      g.lineTo(50, 50);
      g.endFill();
      g.lineStyle(4, G);
      g.lineTo(90, 90);
      probes.push([[29, 31], [70, 70]]);

      // 9: a line style set after the first edge: none on it, and the closing line.
      g = cell(n++);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineStyle(4, K);
      g.lineTo(80, 80);
      g.endFill();
      probes.push([[44, 46], [45, 9]]);

      // 10: closed by drawCircle's move.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(50, 10);
      g.lineTo(50, 50);
      g.drawCircle(70, 70, 15);
      g.endFill();
      probes.push([[29, 31]]);

      // 11: no line style on the second edge, a green one at endFill.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineStyle();
      g.lineTo(80, 80);
      g.lineStyle(4, G);
      g.endFill();
      probes.push([[44, 46], [81, 45]]);

      // 12: gradient fills begin layers as solid ones do.
      g = cell(n++);
      g.lineStyle(6, G);
      g.beginGradientFill("linear", [R, R], [1, 1], [0, 255]);
      g.drawRect(10, 10, 40, 40);
      g.beginGradientFill("linear", [B, B], [1, 1], [0, 255]);
      g.drawRect(30, 30, 40, 40);
      g.endFill();
      probes.push([[50, 40], [40, 30], [20, 40]]);

      // 13: and bitmap fills.
      g = cell(n++);
      g.lineStyle(6, G);
      g.beginBitmapFill(bmpR);
      g.drawRect(10, 10, 40, 40);
      g.beginBitmapFill(bmp);
      g.drawRect(30, 30, 40, 40);
      g.endFill();
      probes.push([[50, 40], [40, 30], [20, 40]]);

      // 14: a solid fill, then a gradient one, the line set after the first.
      g = cell(n++);
      g.beginFill(R);
      g.lineStyle(6, G);
      g.drawRect(10, 10, 40, 40);
      g.beginGradientFill("linear", [B, B], [1, 1], [0, 255]);
      g.drawRect(30, 30, 40, 40);
      g.endFill();
      probes.push([[50, 40], [40, 30]]);

      // 15: copied with copyFrom while open: closed.
      src = new Shape();
      src.graphics.lineStyle(6, K);
      src.graphics.beginFill(R);
      src.graphics.moveTo(10, 10);
      src.graphics.lineTo(80, 10);
      src.graphics.lineTo(80, 80);
      g = cell(n++);
      g.copyFrom(src.graphics);
      probes.push([[45, 45], [10, 45]]);

      // 16: a curved contour closed straight.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.curveTo(80, 10, 80, 80);
      g.endFill();
      probes.push([[45, 45], [60, 40]]);

      // 17: and a cubic one.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.cubicCurveTo(80, 10, 80, 10, 80, 80);
      g.endFill();
      probes.push([[45, 45]]);

      // 18: half-transparent: the closing line no darker than the others.
      g = cell(n++);
      g.lineStyle(10, K, 0.5);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.lineTo(10, 80);
      g.endFill();
      probes.push([[10, 45], [7, 45], [13, 45], [80, 45], [77, 45]]);

      // 19: half-transparent, closed by its own lineTo.
      g = cell(n++);
      g.lineStyle(10, K, 0.5);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.lineTo(10, 80);
      g.lineTo(10, 10);
      g.endFill();
      probes.push([[10, 45], [7, 45], [13, 45]]);

      // 20: a half-transparent drawCircle.
      g = cell(n++);
      g.lineStyle(10, K, 0.5);
      g.beginFill(R);
      g.drawCircle(45, 45, 30);
      g.endFill();
      probes.push([[12, 45], [18, 45]]);

      // 21: a half-transparent single segment in a fill: no closing line over it.
      g = cell(n++);
      g.lineStyle(10, K, 0.5);
      g.beginFill(R);
      g.moveTo(10, 45);
      g.lineTo(80, 45);
      g.endFill();
      probes.push([[45, 45], [45, 42], [10, 45], [80, 45]]);

      // 22: half-transparent, the line style set again partway: its paths meet darker.
      g = cell(n++);
      g.beginFill(R);
      g.lineStyle(10, K, 0.5);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineStyle(10, K, 0.5);
      g.lineTo(80, 80);
      g.lineTo(10, 80);
      g.endFill();
      probes.push([[10, 45], [80, 10], [80, 45]]);

      // 23: two half-transparent contours, the first closed by moveTo, the second by nothing.
      g = cell(n++);
      g.lineStyle(10, K, 0.5);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(40, 10);
      g.lineTo(40, 40);
      g.lineTo(10, 40);
      g.moveTo(50, 50);
      g.lineTo(80, 50);
      g.lineTo(80, 80);
      g.lineTo(50, 80);
      probes.push([[10, 25], [50, 65]]);

      // 24: no line style at endFill, a green line on from the pen.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineStyle(NaN);
      g.lineTo(80, 80);
      g.endFill();
      g.lineStyle(6, G);
      g.lineTo(10, 80);
      probes.push([[45, 45], [45, 80], [10, 45], [80, 45]]);

      // 25: a line on from the pen after endFill takes the closing line away.
      g = cell(n++);
      g.beginFill(R);
      g.lineStyle(6, K);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      g.lineTo(10, 80);
      probes.push([[45, 45], [45, 80], [10, 45]]);

      // 26: the line set after the first edge; bounds and hit tests leave the closing line out.
      g = cell(n++);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineStyle(10, K);
      g.lineTo(80, 80);
      g.endFill();
      probes.push([[45, 45], [41, 47]]);

      // 27: a fill begun after a moveTo.
      g = cell(n++);
      g.lineStyle(6, K);
      g.moveTo(10, 10);
      g.beginFill(R);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      probes.push([[45, 45]]);

      // 28: a line before any fill, under it.
      g = cell(n++);
      g.lineStyle(10, K);
      g.moveTo(0, 45);
      g.lineTo(90, 45);
      g.beginFill(R);
      g.drawRect(30, 30, 30, 30);
      g.endFill();
      probes.push([[45, 45], [10, 45]]);

      // 29: endFill, then a moveTo and a line: kept.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      g.moveTo(10, 80);
      g.lineTo(40, 80);
      probes.push([[45, 45], [25, 80]]);

      // 30: endFill, then another fill: kept.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      g.beginFill(B);
      g.drawRect(10, 60, 20, 20);
      g.endFill();
      probes.push([[45, 45], [20, 70]]);

      // 31: endFill, then a line back to the start.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      g.lineTo(10, 10);
      probes.push([[45, 45]]);

      // 32: endFill, the same line style again, a line on: kept.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      g.lineStyle(6, K);
      g.lineTo(10, 80);
      probes.push([[45, 45], [45, 80]]);

      // 33: endFill alone; bounds and hit tests leave the closing line out.
      g = cell(n++);
      g.lineStyle(6, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(80, 10);
      g.lineTo(80, 80);
      g.endFill();
      probes.push([[45, 45]]);

      var bd:BitmapData = new BitmapData(800, 500, false, 0xffffff);
      bd.draw(this);
      for (var i:int = 0; i < n; i++) {
        var line:String = i + ":";
        for each (var p:Array in probes[i]) {
          line += " " + name(bd.getPixel((i % 8) * 100 + p[0], int(i / 8) * 100 + p[1]));
        }

        trace(line);
      }

      // Bounds, and hit tests just off the closing line, outside the fill.
      for each (var k:int in [0, 26, 15]) {
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
