package {
  import flash.display.*;

  // The order Graphics draws fills and lines in (cases.ts, `line-order`):
  // each fill begins a layer, and the lines drawn until the next fill
  // begins draw over it, whenever their lineStyle was set, and under the
  // next. Each cell draws a red square A at 10..50 and over it a blue
  // square B at 30..70, with black and green lines 4 wide; the trace reads
  // the cells' pixels at the probes below, each name the colour found.
  public class LineOrder extends Sprite {
    private static const R:uint = 0xff0000;
    private static const B:uint = 0x0000ff;
    private static const K:uint = 0x000000;
    private static const G:uint = 0x00ff00;
    // A's left line's inner half, A's right line under B, B's top line over
    // A, A's top line's inner half, B's inside, A's inside on y 40, A's
    // inside on x 40, and two points below them.
    private static const PROBES:Array = [
      [11, 30], [50, 40], [40, 30], [30, 11], [60, 40], [20, 40], [40, 20], [40, 70], [60, 70]
    ];

    public function LineOrder() {
      var g:Graphics;
      var n:int = 0;

      // 0: lineStyle, then beginFill; B's fill begun without endFill.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.drawRect(10, 10, 40, 40);
      g.beginFill(B);
      g.drawRect(30, 30, 40, 40);
      g.endFill();

      // 1: beginFill, then lineStyle.
      g = cell(n++);
      g.beginFill(R);
      g.lineStyle(4, K);
      g.drawRect(10, 10, 40, 40);
      g.beginFill(B);
      g.drawRect(30, 30, 40, 40);
      g.endFill();

      // 2: endFill between, B in green lines set before its fill.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.drawRect(10, 10, 40, 40);
      g.endFill();
      g.lineStyle(4, G);
      g.beginFill(B);
      g.drawRect(30, 30, 40, 40);
      g.endFill();

      // 3: green set after B's fill begins.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.drawRect(10, 10, 40, 40);
      g.beginFill(B);
      g.lineStyle(4, G);
      g.drawRect(30, 30, 40, 40);
      g.endFill();

      // 4: the line changed partway round A: both over A's fill.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.moveTo(10, 10);
      g.lineTo(50, 10);
      g.lineStyle(4, G);
      g.lineTo(50, 50);
      g.lineTo(10, 50);
      g.lineTo(10, 10);
      g.beginFill(B);
      g.drawRect(30, 30, 40, 40);
      g.endFill();

      // 5: a green line across after endFill, over A and under B, which has none.
      g = cell(n++);
      g.beginFill(R);
      g.lineStyle(4, K);
      g.drawRect(10, 10, 40, 40);
      g.endFill();
      g.lineStyle(4, G);
      g.moveTo(0, 40);
      g.lineTo(90, 40);
      g.beginFill(B);
      g.lineStyle();
      g.drawRect(30, 30, 40, 40);
      g.endFill();

      // 6: a line before any fill, under B's fill drawn with its style.
      g = cell(n++);
      g.lineStyle(4, K);
      g.moveTo(0, 40);
      g.lineTo(90, 40);
      g.beginFill(B);
      g.drawRect(30, 30, 40, 40);
      g.endFill();

      // 7: lines alone between fills: black across under B, green down over B and under a red square.
      g = cell(n++);
      g.lineStyle(4, K);
      g.moveTo(0, 40);
      g.lineTo(90, 40);
      g.lineStyle();
      g.beginFill(B);
      g.drawRect(30, 30, 40, 40);
      g.endFill();
      g.lineStyle(4, G);
      g.moveTo(40, 0);
      g.lineTo(40, 90);
      g.lineStyle();
      g.beginFill(R);
      g.drawRect(35, 60, 20, 20);
      g.endFill();

      // 8: B first, with a line across it, then A over both.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(B);
      g.drawRect(30, 30, 40, 40);
      g.moveTo(0, 20);
      g.lineTo(90, 20);
      g.endFill();
      g.beginFill(R);
      g.drawRect(10, 10, 40, 40);
      g.endFill();

      // 9: cleared, then B and a green line across.
      g = cell(n++);
      g.lineStyle(4, K);
      g.beginFill(R);
      g.drawRect(10, 10, 40, 40);
      g.clear();
      g.beginFill(B);
      g.drawRect(30, 30, 40, 40);
      g.endFill();
      g.lineStyle(4, G);
      g.moveTo(0, 40);
      g.lineTo(90, 40);

      // 10: lines 2 wide on their fills, both halves over them.
      g = cell(n++);
      g.lineStyle(2, K);
      g.beginFill(R);
      g.drawRect(10, 10, 40, 30);
      g.endFill();
      g.lineStyle(2, K);
      g.beginFill(R);
      g.drawRoundRect(10, 50, 40, 30, 10);
      g.endFill();

      var bd:BitmapData = new BitmapData(400, 300, false, 0xffffff);
      bd.draw(this);
      // Cell 10's squares are not A and B: its rows only.
      for (var i:int = 0; i < 10; i++) {
        var ox:int = (i % 4) * 100;
        var oy:int = int(i / 4) * 100;
        var line:String = i + ":";
        for each (var p:Array in PROBES) {
          line += " " + name(bd.getPixel(ox + p[0], oy + p[1]));
        }
        trace(line);
      }

      // Cell 10's top edges, rows 8 to 12.
      var rows:String = "10 top rows:";
      for (var y:int = 8; y <= 12; y++) {
        rows += " " + name(bd.getPixel(230, 200 + y)) + "/" + name(bd.getPixel(230, 240 + y));
      }
      trace(rows);
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
      s.x = (i % 4) * 100;
      s.y = int(i / 4) * 100;
      addChild(s);
      return s.graphics;
    }
  }
}
