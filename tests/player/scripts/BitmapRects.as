// How BitmapData's operations take their rects and points, against adl:
// a rect's edges round to the nearest pixel, a half to the even one; a
// point truncates toward 0; a source rect past the source's edge is
// clipped and the point moved with it, except in place when the copy
// moves right and down by no more than its size, where the rect is
// written whole and what lay past the edge comes out empty. In place,
// merge, paletteMap, threshold and copyChannel read each pixel as the
// ones before it left it; a colour matrix goes by fours. Every pixel names
// where it came from, so a line tells which pixels moved and from where.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.filters.BlurFilter;
  import flash.filters.ColorMatrixFilter;
  import flash.geom.ColorTransform;
  import flash.geom.Point;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;

  public class Main extends Sprite {
    private static const N:int = 16;

    public function Main() {
      var r:Array;
      var p:Array;
      var same:Boolean;
      var rects:Array = [[2, 3, 5, 4], [-3, 2, 8, 4], [2, -3, 5, 8], [12, 3, 8, 4], [3, 13, 4, 6], [0.5, 3, 5, 4], [1.5, 3, 5, 4],
        [2.5, 3, 5, 4], [-0.5, 3, 5, 4], [-0.7, 3, 5, 4], [-1.5, 3, 5, 4], [2, 3, 5.5, 4], [2, 3, 4.5, 4], [2.6, 3, 5.6, 4],
        [2, -1.5, 5, 6], [-5, -3, 20, 20], [2.5, 1.7, 10.6, 10.2], [5, 5, -3, 4], [14.5, 2, 3, 3], [15.5, 2, 3, 3]];
      var points:Array = [[3, 4], [3.5, 4], [3.7, 4], [4.5, 4], [-0.5, 4], [-0.7, 4], [-1.5, 4], [3, -1.5], [-3, -2],
        [13.5, 4], [14.5, 4], [3, 14.5], [3.4, 3.6]];

      // From another bitmap, and in place in an opaque one, whose empty pixels draw black.
      for each (same in [false, true]) {
        for each (r in rects) {
          trace("copy", same, r, "@3,4", copy(same, false, r, [3, 4], 0));
        }
        for each (p in points) {
          trace("copy", same, "2,3,5,4 @", p, copy(same, false, [2, 3, 5, 4], p, 0));
        }
      }

      // In place, moved each way past the edges: right and down by no more than the rect leaves it whole.
      var moves:Array = [[-3, 2, 8, 4, 3, 4], [-3, 2, 8, 4, 5, 4], [-3, 2, 8, 4, 6, 3], [-3, 2, 8, 4, 5, 6], [-3, 2, 8, 4, 5, 7],
        [-3, 2, 8, 4, 3, 2], [-3, 2, 8, 4, 2, 0], [-3, 2, 8, 4, -1, 1], [-3, 2, 8, 4, -2, 3], [2, -3, 4, 8, 2, 5],
        [2, -3, 4, 8, 6, 5], [2, -3, 4, 8, 7, 5], [2, -3, 4, 8, 1, -1], [-3, -3, 8, 8, 0, 0], [-3, -3, 8, 8, -3, -1],
        [-2, -1, 4, 3, 3, 4], [-2.5, 2, 8, 4, 3.5, 4.5], [2.5, -2.5, 4, 8, 2, 5], [12, 3, 8, 4, 10, 4], [2, 3, 5, 4, 1, 4],
        [2, 3, 5, 4, 3, 2], [10, 2, 8, 4, 6, 3]];
      for each (var m:Array in moves) {
        r = m.slice(0, 4);
        p = m.slice(4);
        trace("inplace", r, "@", p, copy(true, false, r, p, 0), "/", copy(true, false, r, p, 4), "/", copy(true, false, r, p, 2, [0, 0]));
        trace("inplace drawn", r, "@", p, copy(true, true, r, p, 0), "/", copy(true, true, r, p, 2, [0, 0]));
      }

      // Transparent, in place, where nothing past the edge is written.
      for each (m in [[2, 3, 5, 4, 3, 4], [2, 3, 5, 4, 1, 4], [12, 3, 8, 4, 10, 4], [-2, -1, 4, 3, 3, 4], [-3, 2, 8, 4, 2, 0],
        [-3, 2, 8, 4, 6, 3], [2.5, 3, 5.5, 4, 3.5, 4]]) {
        r = m.slice(0, 4);
        p = m.slice(4);
        trace("transparent inplace", r, "@", p, copy(true, false, r, p, 0, null, true), "/", copy(true, true, r, p, 0, null, true));
      }

      // Drawn on the GPU first, from another bitmap.
      for each (r in [[-3, 2, 8, 4], [2.5, 3, 5.5, 4], [-1.5, 3, 5, 4], [-5, -3, 20, 20], [2.5, 1.7, 10.6, 10.2]]) {
        for each (p in [[3, 4], [3.5, 4], [-1.5, 4], [10, 10], [3.4, 3.6]]) {
          trace("drawn", r, "@", p, copy(false, true, r, p, 0), "/", copy(false, true, r, p, 0, null, true));
        }
      }

      // An alpha bitmap of 6 by 5, opaque, at a point: where it reaches; and merging.
      for each (r in [[2, 3, 5, 4], [-3, 2, 8, 4], [2.5, 3, 5.5, 4], [-1.5, 3, 5, 4]]) {
        for each (var ap:Array in [[0, 0], [1.5, 2], [2.5, 2], [-1.5, 0], [-0.5, 0], [0.5, 0], [1, 2.5]]) {
          for each (p in [[3, 4], [3.5, 4], [-1.5, 4]]) {
            trace("alpha", r, "@", p, "ap", ap, copy(false, false, r, p, 2, ap), "/", copy(false, true, r, p, 2, ap));
          }
        }
        for each (p in [[3, 4], [3.5, 4], [-1.5, 4]]) {
          trace("merge", r, "@", p, copy(false, false, r, p, 4), "/", copy(false, false, r, p, 4, null, true));
        }
      }

      // The other operations taking a source rect and a point, in place too.
      for each (var op:String in ["copyChannel", "merge", "paletteMap", "threshold", "applyFilter", "pixelDissolve"]) {
        for each (same in [false, true]) {
          for each (r in [[2, 3, 5, 4], [-3, 2, 8, 4], [2.5, 3, 5.5, 4], [-1.5, 3, 5, 4], [1.5, 3, 5, 4], [-5, -3, 20, 20], [12, 3, 8, 4]]) {
            for each (p in [[3, 4], [3.5, 4], [-1.5, 4], [3.4, 3.6], [13, 4], [1, 4], [3, 2]]) {
              trace(op, same, r, "@", p, other(op, same, r, p));
            }
          }
        }
      }

      // A channel onto itself, in place, reads what it wrote.
      for each (m in [[2, 3, 5, 4, 3, 4], [2, 3, 5, 4, 1, 4], [-3, 2, 8, 4, 3, 4]]) {
        var self:BitmapData = pattern(2, false);
        self.copyChannel(self, new Rectangle(m[0], m[1], m[2], m[3]), new Point(m[4], m[5]), 1, 1);
        trace("copyChannel self", m, reds(self));
      }

      // A colour matrix in place, a row moved right: by fours from its start.
      var id:ColorMatrixFilter = new ColorMatrixFilter([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
      for each (var x0:int in [0, 1]) {
        for each (var dx:int in [1, 2, 3]) {
          for each (var w:int in [3, 4, 5, 8, 9]) {
            var row:BitmapData = pattern(2, false);
            row.applyFilter(row, new Rectangle(x0, 3, w, 1), new Point(x0 + dx, 3), id);
            trace("matrix row", x0, dx, w, reds(row));
          }
        }
      }

      // The operations on a rect alone.
      var lone:Array = [[2, 3, 5, 4], [-3, 2, 8, 4], [0.5, 3, 5, 4], [1.5, 3, 5, 4], [2.5, 3, 5, 4], [-0.5, 3, 5, 4], [-1.5, 3, 5, 4],
        [2, 3, 5.5, 4], [2, 3, 4.5, 4], [2.3, 3, 5.4, 4], [2.6, 3, 5.6, 4], [2.5, 1.7, 10.6, 10.2], [-5, -3, 20, 20], [14.5, 2, 3, 3],
        [5, 5, -3, 4], [5, 5, 3, -4], [20, 20, 5, 5], [5, 5, 0, 0], [15.5, 3, 1, 1], [-3, -3, 3.4, 3.6]];
      for each (var lop:String in ["fillRect", "fillDrawn", "colorTransform", "getPixels", "setPixels", "getVector", "setVector",
          "histogram", "drawClip", "pixelDissolve", "hitTest", "generateFilterRect"]) {
        for each (r in lone) {
          trace(lop, r, single(lop, r));
        }
      }

      // hitTest's rects round as the rest do; its points truncate.
      var hb:BitmapData = new BitmapData(N, N, true, 0);
      hb.setPixel32(4, 4, 0xFFFFFFFF);
      for each (r in [[3.3, 4, 1.4, 1], [4.4, 4, 0.2, 1], [4.5, 4, 1, 1], [3.5, 4, 1, 1], [3.6, 4, 0.8, 1], [4, 3.3, 1, 1.4],
        [-1, 4, 5.5, 1], [4.9, 4, 0.3, 1]]) {
        trace("hitTest rect", r, hb.hitTest(new Point(0, 0), 1, new Rectangle(r[0], r[1], r[2], r[3])));
      }
      var dot:BitmapData = new BitmapData(2, 2, true, 0xFFFFFFFF);
      for each (p in [[0.5, 0], [-0.5, 0], [0.7, 0], [-0.7, 0], [1.5, 0], [-1.5, 0], [4.5, 0], [-4.5, 0], [0, 0.6], [0, -0.6]]) {
        trace("hitTest point", p, hb.hitTest(new Point(p[0], p[1]), 1, new Point(4 + p[0], 4)),
          hb.hitTest(new Point(p[0], p[1]), 1, new Rectangle(4 + p[0], 4 + p[1], 1, 1)),
          hb.hitTest(new Point(0, 0), 1, dot, new Point(p[0] + 3, p[1] + 3)), hb.hitTest(new Point(p[0], p[1]), 1, dot, new Point(3, 3)));
      }

      // scroll truncates as well.
      for each (var s:Array in [[1.5, 0], [-1.5, 0], [0.5, 0], [2.7, -0.7], [-2.7, 1.2]]) {
        var b:BitmapData = pattern(2, false);
        b.scroll(s[0], s[1]);
        trace("scroll", s, describe(b, true));
      }

      // Shown: an opaque bitmap with empty pixels, as drawn, and one drawn on the GPU first.
      var shown:BitmapData = pattern(2, false);
      shown.copyPixels(shown, new Rectangle(-3, -2, 8, 7), new Point(3, 4));
      var drawn:BitmapData = drawnPattern(2, false);
      drawn.copyPixels(drawn, new Rectangle(-3, -2, 8, 7), new Point(3, 4));
      var left:Bitmap = new Bitmap(shown);
      left.scaleX = left.scaleY = 2;
      addChild(left);
      var right:Bitmap = new Bitmap(drawn);
      right.scaleX = right.scaleY = 2;
      right.x = 40;
      addChild(right);
    }

    /** A bitmap whose every pixel names its place, and the marker of its bitmap. */
    private function pattern(marker:int, transparent:Boolean = true):BitmapData {
      var bd:BitmapData = new BitmapData(N, N, transparent, 0);
      for (var y:int = 0; y < N; y++) {
        for (var x:int = 0; x < N; x++) {
          bd.setPixel32(x, y, 0xFF000000 | ((x + 0x10) << 16) | ((y + 0x10) << 8) | marker);
        }
      }
      return bd;
    }

    /** The pattern drawn into a bitmap, which leaves it on the GPU. */
    private function drawnPattern(marker:int, transparent:Boolean = true):BitmapData {
      var sp:Sprite = new Sprite();
      sp.addChild(new Bitmap(pattern(marker)));
      var bd:BitmapData = new BitmapData(N, N, transparent, 0);
      bd.draw(sp);
      return bd;
    }

    /**
     * A copy, in place or from another bitmap; drawn first or not; mode 0
     * plain, 2 through a 6 by 5 alpha bitmap at `ap`, 4 merging. In place
     * the bitmap is opaque, from another one transparent, unless `flip`.
     */
    private function copy(same:Boolean, gpu:Boolean, r:Array, p:Array, mode:int, ap:Array = null, flip:Boolean = false):String {
      var t:Boolean = same == flip;
      var dst:BitmapData = gpu ? drawnPattern(2, t) : pattern(2, t);
      var src:BitmapData = same ? dst : pattern(1);
      var rect:Rectangle = new Rectangle(r[0], r[1], r[2], r[3]);
      var pt:Point = new Point(p[0], p[1]);
      if (mode == 2) {
        dst.copyPixels(src, rect, pt, new BitmapData(6, 5, true, 0xFF000000), new Point(ap[0], ap[1]));
      } else {
        dst.copyPixels(src, rect, pt, null, null, mode == 4);
      }
      return describe(dst, same);
    }

    private function other(op:String, same:Boolean, r:Array, p:Array):String {
      var dst:BitmapData = pattern(2);
      var src:BitmapData = same ? dst : pattern(1);
      var rect:Rectangle = new Rectangle(r[0], r[1], r[2], r[3]);
      var pt:Point = new Point(p[0], p[1]);
      switch (op) {
        case "copyChannel":
          // Blue from red, then on a second bitmap from green: the source's x and y.
          var dst2:BitmapData = pattern(2);
          dst.copyChannel(src, rect, pt, 1, 4);
          dst2.copyChannel(same ? dst2 : src, rect, pt, 2, 4);
          return channels(dst, dst2);
        case "merge":
          dst.merge(src, rect, pt, 256, 256, 256, 256);
          break;
        case "paletteMap":
          dst.paletteMap(src, rect, pt);
          break;
        case "threshold":
          var n:uint = dst.threshold(src, rect, pt, "==", 0x01020304, 0xFFFF0000, 0xFFFFFFFF, true);
          return n + " " + describe(dst, same);
        case "applyFilter":
          dst.applyFilter(src, rect, pt, new ColorMatrixFilter([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]));
          break;
        case "pixelDissolve":
          // Every pixel: in place, the fill colour, black and empty.
          var seed:int = dst.pixelDissolve(src, rect, pt, 0, 1000, 0);
          return seed + " " + describe(dst, same);
      }
      return describe(dst, same);
    }

    /** The pixels whose blue two copyChannels set: their box, and where they came from. */
    private function channels(a:BitmapData, b:BitmapData):String {
      var x0:int = N, y0:int = N, x1:int = -1, y1:int = -1, n:int = 0;
      var ox:String = null, oy:String = null, mixed:Boolean = false;
      for (var y:int = 0; y < N; y++) {
        for (var x:int = 0; x < N; x++) {
          var ba:int = a.getPixel32(x, y) & 0xff;
          var bb:int = b.getPixel32(x, y) & 0xff;
          if (ba == 2 && bb == 2) {
            continue;
          }
          n++;
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          var dx:String = String(x - (ba - 0x10));
          var dy:String = String(y - (bb - 0x10));
          if (ox == null) { ox = dx; oy = dy; } else if (ox != dx || oy != dy) { mixed = true; }
        }
      }
      if (n == 0) {
        return "none";
      }
      return box(x0, y0, x1, y1, n) + (mixed ? " mixed" : " from " + (x0 - int(ox)) + "," + (y0 - int(oy)));
    }

    /**
     * The pixels changed: their box, how many came out empty, and where the
     * rest came from, one offset for all or, where they part, each pixel's
     * source in reading order.
     */
    private function describe(bd:BitmapData, same:Boolean):String {
      var x0:int = N, y0:int = N, x1:int = -1, y1:int = -1, n:int = 0, empty:int = 0;
      var off:String = null, mixed:Boolean = false, odd:int = 0;
      var sources:Array = [];
      for (var y:int = 0; y < N; y++) {
        for (var x:int = 0; x < N; x++) {
          var c:uint = bd.getPixel32(x, y);
          var sx:int = ((c >> 16) & 0xff) - 0x10;
          var sy:int = ((c >> 8) & 0xff) - 0x10;
          var mk:int = c & 0xff;
          var changed:Boolean = same ? (sx != x || sy != y || (c >>> 24) != 0xff) : (mk != 2 || sx != x || sy != y);
          if (!changed) {
            continue;
          }
          n++;
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          if ((c >>> 24) != 0xff || (mk != 1 && mk != 2)) {
            // Empty: in an opaque bitmap Flash reads 0, alpha and all, and draws black; the
            // player keeps it opaque black, which draws the same, so the alpha goes uncompared.
            if ((c & 0xffffff) == 0) {
              empty++;
            } else {
              odd++;
              sources.push(c.toString(16));
            }
            continue;
          }
          sources.push(sx + "," + sy);
          var o:String = (x - sx) + "," + (y - sy);
          if (off == null) { off = o; } else if (off != o) { mixed = true; }
        }
      }
      if (n == 0) {
        return "none";
      }
      var s:String = box(x0, y0, x1, y1, n) + (empty ? " empty=" + empty : "");
      if (mixed || odd) {
        return s + " [" + sources.join(" ") + "]";
      }
      if (off == null) {
        return s;
      }
      var parts:Array = off.split(",");
      return s + " shift " + parts[0] + "," + parts[1];
    }

    private function box(x0:int, y0:int, x1:int, y1:int, n:int):String {
      var area:int = (x1 - x0 + 1) * (y1 - y0 + 1);
      return x0 + "," + y0 + " " + (x1 - x0 + 1) + "x" + (y1 - y0 + 1) + (n != area ? " n=" + n : "");
    }

    /** Each pixel's red, the column it came from, where that is not its own. */
    private function reds(bd:BitmapData):String {
      var s:String = "";
      for (var y:int = 0; y < N; y++) {
        for (var x:int = 0; x < N; x++) {
          var sx:int = ((bd.getPixel32(x, y) >> 16) & 0xff) - 0x10;
          if (sx != x) {
            s += " " + x + "," + y + "=" + sx;
          }
        }
      }
      return s;
    }

    private function single(op:String, r:Array):String {
      var bd:BitmapData = op == "fillDrawn" ? drawnPattern(2) : pattern(2);
      var rect:Rectangle = new Rectangle(r[0], r[1], r[2], r[3]);
      var i:int;
      try {
        switch (op) {
          case "fillRect":
          case "fillDrawn":
            bd.fillRect(rect, 0xFFFFFFFF);
            break;
          case "colorTransform":
            bd.colorTransform(rect, new ColorTransform(1, 1, 1, 1, 0, 0, 255, 0));
            break;
          case "getPixels":
            var ba:ByteArray = bd.getPixels(rect);
            return ba.length / 4 + (ba.length ? " first " + (ba[1] - 0x10) + "," + (ba[2] - 0x10) : "");
          case "setPixels":
            var bytes:ByteArray = new ByteArray();
            for (i = 0; i < 400; i++) {
              bytes.writeUnsignedInt(0xFFFFFFFF);
            }
            bytes.position = 0;
            bd.setPixels(rect, bytes);
            return bytes.position / 4 + " " + whites(bd);
          case "getVector":
            var v:Vector.<uint> = bd.getVector(rect);
            return v.length + (v.length ? " first " + (((v[0] >> 16) & 0xff) - 0x10) + "," + (((v[0] >> 8) & 0xff) - 0x10) : "");
          case "setVector":
            var vector:Vector.<uint> = new Vector.<uint>();
            for (i = 0; i < 400; i++) {
              vector.push(0xFFFFFFFF);
            }
            bd.setVector(rect, vector);
            return whites(bd);
          case "histogram":
            var h:Vector.<Vector.<Number>> = bd.histogram(rect);
            var total:Number = 0;
            for (i = 0; i < 256; i++) {
              total += h[3][i];
            }
            return String(total);
          case "drawClip":
            bd.draw(new BitmapData(N, N, false, 0xFFFFFF), null, null, null, rect);
            return whites(bd);
          case "pixelDissolve":
            // In place the source rect dissolves wherever the point is; a negative size spans back.
            var seed:int = bd.pixelDissolve(bd, rect, new Point(9, 9), 0, 1000, 0xFFFFFFFF);
            var into:BitmapData = pattern(2);
            var seed2:int = into.pixelDissolve(new BitmapData(N, N, true, 0xFFFFFFFF), rect, new Point(8.5, 1.5), 0, 1000);
            return seed + " " + whites(bd) + " / " + seed2 + " " + whites(into);
          case "hitTest":
            var hb:BitmapData = new BitmapData(N, N, true, 0);
            hb.setPixel32(4, 4, 0xFFFFFFFF);
            return String(hb.hitTest(new Point(0, 0), 1, rect));
          case "generateFilterRect":
            return bd.generateFilterRect(rect, new ColorMatrixFilter()) + " " + bd.generateFilterRect(rect, new BlurFilter(4, 4, 1));
        }
      } catch (e:Error) {
        return "error " + e.errorID;
      }
      return whites(bd);
    }

    /** The box of the pixels gone white, or blue 255. */
    private function whites(bd:BitmapData):String {
      var x0:int = N, y0:int = N, x1:int = -1, y1:int = -1, n:int = 0;
      for (var y:int = 0; y < N; y++) {
        for (var x:int = 0; x < N; x++) {
          if ((bd.getPixel32(x, y) & 0xff) != 0xff) {
            continue;
          }
          n++;
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
      if (n == 0) {
        return "none";
      }
      return box(x0, y0, x1, y1, n);
    }
  }
}
