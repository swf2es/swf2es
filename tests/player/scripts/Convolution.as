package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;

  // BitmapData.applyFilter and generateFilterRect with a ConvolutionFilter
  // against adl: where each tap reads, straight colour and alpha kept or
  // convolved, divisor and bias, the edges clamped or coloured, a subrect,
  // and the 3x3 kernels a divisor other than 1 takes another way.
  public class Convolution extends Sprite {

    /** A w × h source with one pixel at (px, py), filtered into a fresh green destination; its pixels as rows. */
    private function spot(label:String, f:ConvolutionFilter, color:uint = 0xff4080c0, transparent:Boolean = true,
        w:int = 7, h:int = 7, px:int = 3, py:int = 3):void {
      var s:BitmapData = new BitmapData(w, h, transparent, transparent ? 0 : 0xff000000);
      s.setPixel32(px, py, color);
      var d:BitmapData = new BitmapData(w, h, true, 0xff00ff00);
      d.applyFilter(s, s.rect, new Point(0, 0), f);
      dump(label, d);
    }

    /** A gradient source, every pixel its own, filtered whole. */
    private function gradient(label:String, f:ConvolutionFilter, transparent:Boolean = false):void {
      var s:BitmapData = new BitmapData(8, 6, transparent, 0);
      for (var y:int = 0; y < 6; y++) {
        for (var x:int = 0; x < 8; x++) {
          var a:uint = transparent ? 0x40 + x * 24 : 0xff;
          s.setPixel32(x, y, (a << 24) | ((x * 32) << 16) | ((y * 40) << 8) | ((x * y * 5) & 0xff));
        }
      }
      var d:BitmapData = new BitmapData(8, 6, true, 0xff00ff00);
      d.applyFilter(s, s.rect, new Point(0, 0), f);
      dump(label, d);
    }

    private function dump(label:String, b:BitmapData):void {
      trace(label);
      for (var y:int = 0; y < b.height; y++) {
        var row:Array = [];
        for (var x:int = 0; x < b.width; x++) {
          var p:uint = b.getPixel32(x, y);
          row.push(p == 0xff00ff00 ? "." : p == 0 ? "0" : p == 0xff000000 ? "-" : p.toString(16));
        }
        trace(" " + row.join(" "));
      }
    }

    private function fill(n:int, v:Number = 1):Array {
      var a:Array = [];
      for (var i:int = 0; i < n; i++) a.push(v);
      return a;
    }

    private function taps():void {
      for (var k:int = 0; k < 9; k++) {
        var m:Array = fill(9, 0);
        m[k] = 1;
        spot("tap " + k, new ConvolutionFilter(3, 3, m, 1, 0, false), 0xff4080c0, true, 5, 5, 2, 2);
        spot("tap " + k + " alpha kept", new ConvolutionFilter(3, 3, m, 1, 0, true), 0xff4080c0, true, 5, 5, 2, 2);
      }
      spot("2x1 first", new ConvolutionFilter(2, 1, [1, 0]), 0xff4080c0, false, 5, 3, 2, 1);
      spot("2x1 last", new ConvolutionFilter(2, 1, [0, 1]), 0xff4080c0, false, 5, 3, 2, 1);
      spot("4x2 first", new ConvolutionFilter(4, 2, [1, 0, 0, 0, 0, 0, 0, 0]), 0xff4080c0, false, 7, 5, 3, 2);
      spot("4x2 last", new ConvolutionFilter(4, 2, [0, 0, 0, 0, 0, 0, 0, 1]), 0xff4080c0, false, 7, 5, 3, 2);
      spot("short matrix", new ConvolutionFilter(3, 3, [0, 0, 0, 0, 1]), 0xff4080c0, false, 5, 5, 2, 2);
    }

    private function values():void {
      spot("half centre", new ConvolutionFilter(3, 3, [0, 0, 0, 0, 1, 0, 0, 0, 0], 1, 0, false), 0x80ff0000);
      spot("half box", new ConvolutionFilter(3, 3, fill(9), 9, 0, false), 0x80ff0000);
      spot("half box alpha kept", new ConvolutionFilter(3, 3, fill(9), 9, 0, true), 0x80ff0000);
      spot("half x2", new ConvolutionFilter(1, 1, [2], 1, 0, false), 0x80ff0000);
      spot("half x0.5", new ConvolutionFilter(1, 1, [0.5], 1, 0, false), 0x80ff0000);
      spot("third 0.3", new ConvolutionFilter(1, 1, [0.3], 1, 0, false), 0x55336699);
      spot("x0.3", new ConvolutionFilter(1, 1, [0.3]), 0xff4080c0, false);
      spot("x0.7", new ConvolutionFilter(1, 1, [0.7]), 0xff4080c0, false);
      spot("bias 64", new ConvolutionFilter(1, 1, [1], 1, 64, false));
      spot("bias 64 alpha kept", new ConvolutionFilter(1, 1, [1], 1, 64, true));
      spot("bias -1.5", new ConvolutionFilter(1, 1, [1], 1, -1.5), 0xff4080c0, false);
      spot("bias 0.6", new ConvolutionFilter(1, 1, [1], 1, 0.6), 0xff4080c0, false);
      spot("negative bias 255", new ConvolutionFilter(1, 1, [-1], 1, 255), 0xff4080c0, false);
      spot("divisor 0", new ConvolutionFilter(1, 1, [0.5], 0), 0xff4080c0, false);
      spot("divisor -1", new ConvolutionFilter(1, 1, [1], -1, 255), 0xff4080c0, false);
      spot("box /1 saturates", new ConvolutionFilter(3, 3, fill(9), 1), 0xff4080c0, false);
      spot("box ninths /1", new ConvolutionFilter(3, 3, fill(9, 1 / 9), 1), 0xff4080c0, false);
    }

    private function threeByThree():void {
      spot("box /9", new ConvolutionFilter(3, 3, fill(9), 9), 0xff4080c0, false);
      spot("box /9 corner", new ConvolutionFilter(3, 3, fill(9), 9), 0xff4080c0, false, 7, 7, 1, 1);
      spot("ramp /45", new ConvolutionFilter(3, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9], 45), 0xff4080c0, false);
      spot("box /3", new ConvolutionFilter(3, 3, fill(9), 3), 0xff306090, false);
      spot("box /2", new ConvolutionFilter(3, 3, fill(9), 2), 0xff306090, false);
      spot("box /2 bias", new ConvolutionFilter(3, 3, fill(9), 2, 16), 0xff306090, false);
      spot("box /1.5", new ConvolutionFilter(3, 3, fill(9), 1.5), 0xff306090, false);
      spot("box /2.0001", new ConvolutionFilter(3, 3, fill(9), 2.0001), 0xff306090, false);
      spot("box /0.5", new ConvolutionFilter(3, 3, fill(9), 0.5), 0xff102030, false);
      spot("box /-1", new ConvolutionFilter(3, 3, fill(9), -1, 128), 0xff102030, false);
      spot("centre 2 /2", new ConvolutionFilter(3, 3, [0, 0, 0, 0, 2, 0, 0, 0, 0], 2), 0xff306090, false);
      spot("last -1 /9", new ConvolutionFilter(3, 3, [1, 1, 1, 1, 1, 1, 1, 1, -1], 9, 64), 0xff906030, false);
      spot("box /9 alpha", new ConvolutionFilter(3, 3, fill(9), 9, 0, false), 0xc0ff8040);
      spot("5x5 /25", new ConvolutionFilter(5, 5, fill(25), 25), 0xffffc080, false, 9, 9, 4, 4);
      spot("5x5 /2", new ConvolutionFilter(5, 5, fill(25), 2), 0xff402010, false, 9, 9, 4, 4);
      gradient("sharpen", new ConvolutionFilter(3, 3, [0, -1, 0, -1, 5, -1, 0, -1, 0], 1));
      gradient("sharpen /2", new ConvolutionFilter(3, 3, [0, -1, 0, -1, 6, -1, 0, -1, 0], 2));
      gradient("emboss", new ConvolutionFilter(3, 3, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 1, 0));
      gradient("blur /16", new ConvolutionFilter(3, 3, [1, 2, 1, 2, 4, 2, 1, 2, 1], 16));
      gradient("blur /16 transparent", new ConvolutionFilter(3, 3, [1, 2, 1, 2, 4, 2, 1, 2, 1], 16, 0, false), true);
      gradient("edges /4 bias", new ConvolutionFilter(3, 3, [0, 1, 0, 1, -4, 1, 0, 1, 0], 4, 128), true);
    }

    private function edges():void {
      gradient("clamped", new ConvolutionFilter(3, 3, [1, 0, 0, 0, 0, 0, 0, 0, 1], 1));
      gradient("coloured", new ConvolutionFilter(3, 3, [1, 0, 0, 0, 0, 0, 0, 0, 1], 1, 0, true, false, 0xff8000, 1));
      gradient("coloured half", new ConvolutionFilter(3, 3, fill(9), 9, 0, false, false, 0x808080, 0.5), true);
      gradient("coloured alpha kept", new ConvolutionFilter(3, 3, fill(9), 9, 0, true, false, 0xff0000, 0.5), true);
      gradient("5x1 clamped", new ConvolutionFilter(5, 1, [1, 0, 0, 0, 1], 2));
    }

    private function regions():void {
      var s:BitmapData = new BitmapData(10, 8, false, 0);
      for (var y:int = 0; y < 8; y++) {
        for (var x:int = 0; x < 10; x++) {
          s.setPixel(x, y, (x * 25) << 16 | (y * 30) << 8 | 0x40);
        }
      }
      var f:ConvolutionFilter = new ConvolutionFilter(3, 3, [1, 0, 0, 0, 0, 0, 0, 0, 1], 1);
      var d:BitmapData = new BitmapData(10, 8, true, 0xff00ff00);
      d.applyFilter(s, new Rectangle(2, 2, 5, 4), new Point(1, 3), f);
      dump("subrect", d);
      var d2:BitmapData = new BitmapData(10, 8, true, 0xff00ff00);
      d2.applyFilter(s, new Rectangle(-2, -1, 6, 5), new Point(0, 0), f);
      dump("subrect past the source", d2);
      var d3:BitmapData = new BitmapData(10, 8, true, 0xff00ff00);
      d3.applyFilter(s, new Rectangle(6, 5, 6, 5), new Point(6, 5), new ConvolutionFilter(3, 3, [1, 0, 0, 0, 0, 0, 0, 0, 1], 1, 0, true, false, 0x0000ff, 1));
      dump("subrect coloured", d3);
      var half:BitmapData = new BitmapData(6, 5, true, 0);
      half.fillRect(new Rectangle(1, 1, 4, 3), 0x80ff8040);
      half.setPixel32(2, 2, 0x40206080);
      var opaque:BitmapData = new BitmapData(6, 5, false, 0x0000ff);
      opaque.applyFilter(half, half.rect, new Point(0, 0), new ConvolutionFilter(3, 3, fill(9), 9));
      dump("into opaque", opaque);
      opaque.applyFilter(half, half.rect, new Point(0, 0), new ConvolutionFilter(3, 3, fill(9), 9, 0, false));
      dump("into opaque, alpha convolved", opaque);
      opaque.applyFilter(half, half.rect, new Point(0, 0), new ConvolutionFilter(1, 1, [1]));
      dump("into opaque, copied", opaque);
      // An empty kernel copies the source rect, to where the grown rect's corner lands.
      var empty:Array = [new ConvolutionFilter(), new ConvolutionFilter(0, 0, [], 1, 64, false),
        new ConvolutionFilter(0, 3, [1, 1, 1], 1, 0, false), new ConvolutionFilter(3, 0, [1, 1, 1], 1, 10)];
      for each (var e:ConvolutionFilter in empty) {
        var into:BitmapData = new BitmapData(7, 6, true, 0xff0000ff);
        into.applyFilter(half, new Rectangle(1, 1, 4, 3), new Point(2, 2), e);
        dump("empty " + e.matrixX + "x" + e.matrixY + ", rect " + into.generateFilterRect(new Rectangle(1, 1, 4, 3), e), into);
      }
      var opaqueInto:BitmapData = new BitmapData(7, 6, false, 0x0000ff);
      opaqueInto.applyFilter(half, half.rect, new Point(0, 0), new ConvolutionFilter());
      dump("empty into opaque", opaqueInto);
      var self:BitmapData = s.clone();
      self.applyFilter(self, self.rect, new Point(0, 0), new ConvolutionFilter(3, 3, [1, 1, 1, 1, 1, 1, 1, 1, 1], 9));
      dump("in place", self);

      var b:BitmapData = new BitmapData(20, 20);
      var r:Rectangle = new Rectangle(2, 1, 3, 2);
      trace("rect", b.generateFilterRect(r, new ConvolutionFilter(3, 3, fill(9))),
        b.generateFilterRect(r, new ConvolutionFilter(1, 1, [1])),
        b.generateFilterRect(r, new ConvolutionFilter(2, 2, fill(4))),
        b.generateFilterRect(r, new ConvolutionFilter(4, 1, fill(4))),
        b.generateFilterRect(r, new ConvolutionFilter(5, 3, fill(15))),
        b.generateFilterRect(r, new ConvolutionFilter(0, 0, [])));
    }

    public function Convolution() {
      taps();
      values();
      threeByThree();
      edges();
      regions();
    }
  }
}
