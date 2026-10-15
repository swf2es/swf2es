package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Graphics;
  import flash.display.GraphicsPath;
  import flash.display.GraphicsSolidFill;
  import flash.display.GraphicsTrianglePath;
  import flash.display.IGraphicsData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.filters.GlowFilter;
  import flash.geom.ColorTransform;
  import flash.geom.Matrix;
  import flash.geom.Rectangle;
  import flash.utils.getQualifiedClassName;

  // Graphics.drawTriangles: each triangle a fill of its own, so overlapping
  // ones never cancel; culling; the lines around each; the pen left where
  // it was and the open fill's contour going on after; bitmap fills
  // through their matrix without uvtData, and textured by u and v with it,
  // in perspective by t, repeating or clamped, smoothed or not; a solid
  // fill with uvtData drawing nothing; colour transforms, a filter, a
  // rotation and BitmapData.draw of textured triangles; the texture's
  // change on the next frame; and what readGraphicsData, the bounds, the
  // hit tests and the errors say.
  public class DrawTriangles extends Sprite {
    private var texture:BitmapData;
    private var shapes:Array = [];

    public function DrawTriangles() {
      texture = new BitmapData(4, 4, true, 0);
      for (var y:int = 0; y < 4; y++) {
        for (var x:int = 0; x < 4; x++) {
          texture.setPixel32(x, y, 0xFF000000 | (x * 80) << 16 | (y * 80) << 8 | (x + y) * 30);
        }
      }
      texture.setPixel32(3, 0, 0x80FF8000);

      var quad:Vector.<Number> = Vector.<Number>([0, 0, 50, 0, 50, 50, 0, 50]);
      var corners:Vector.<int> = Vector.<int>([0, 1, 2, 0, 2, 3]);
      var g:Graphics;

      // Overlapping, the same way round and the other: each its own fill, half transparent.
      g = cell(0, 0).graphics;
      g.beginFill(0xCC0000, 0.5);
      g.drawTriangles(Vector.<Number>([0, 0, 40, 0, 0, 40, 10, 10, 50, 10, 10, 50, 50, 50, 10, 50, 50, 10]));
      g.endFill();

      // Culling: positive drops the clockwise one, negative the other.
      g = cell(1, 0).graphics;
      g.beginFill(0x00AA00);
      g.drawTriangles(Vector.<Number>([0, 0, 25, 0, 0, 25, 25, 25, 25, 50, 50, 25]), null, null, "positive");
      g.beginFill(0x0000AA);
      g.drawTriangles(Vector.<Number>([25, 0, 50, 0, 25, 25, 0, 25, 0, 50, 25, 50]), null, null, "negative");

      // Lines alone, mitred: each outline closed and joined.
      g = cell(2, 0).graphics;
      g.lineStyle(4, 0x3366FF, 1, false, "normal", "none", "miter");
      g.drawTriangles(quad, corners);

      // A fill and a line: the lines over all the triangles.
      g = cell(3, 0).graphics;
      g.lineStyle(2, 0x000000);
      g.beginFill(0xFFCC00);
      g.drawTriangles(Vector.<Number>([0, 0, 40, 0, 0, 40, 10, 10, 50, 10, 10, 50]));
      g.endFill();

      // The pen stays: the line goes on from where it was, a path of its own.
      g = cell(4, 0).graphics;
      g.lineStyle(2, 0xCC00CC);
      g.moveTo(0, 50);
      g.lineTo(25, 25);
      g.drawTriangles(Vector.<Number>([30, 0, 50, 0, 50, 20]));
      g.lineTo(50, 50);

      // The open contour ends at the triangles and goes on after them, closing to its start.
      g = cell(5, 0).graphics;
      g.lineStyle(2, 0x000000);
      g.beginFill(0x00CCCC);
      g.moveTo(0, 0);
      g.lineTo(50, 0);
      g.drawTriangles(Vector.<Number>([5, 35, 15, 35, 5, 45]));
      g.lineTo(50, 50);
      g.endFill();

      // A bitmap fill without uvtData: through its matrix.
      g = cell(0, 1).graphics;
      g.beginBitmapFill(texture, new Matrix(10, 0, 0, 10), false, false);
      g.drawTriangles(quad, corners);

      // Textured, not smoothed and smoothed, clamped.
      g = cell(1, 1).graphics;
      g.beginBitmapFill(texture, new Matrix(3, 0, 0, 3), false, false);
      g.drawTriangles(quad, corners, Vector.<Number>([0, 0, 1, 0, 1, 1, 0, 1]));
      g = cell(2, 1).graphics;
      g.beginBitmapFill(texture, null, false, true);
      g.drawTriangles(quad, corners, Vector.<Number>([0, 0, 1, 0, 1, 1, 0, 1]));

      // Repeating, from -0.5 to 1.5, not smoothed and smoothed.
      g = cell(3, 1).graphics;
      g.beginBitmapFill(texture, null, true, false);
      g.drawTriangles(quad, corners, Vector.<Number>([-0.5, -0.5, 1.5, -0.5, 1.5, 1.5, -0.5, 1.5]));
      g = cell(4, 1).graphics;
      g.beginBitmapFill(texture, null, true, true);
      g.drawTriangles(quad, corners, Vector.<Number>([-0.5, -0.5, 1.5, -0.5, 1.5, 1.5, -0.5, 1.5]));

      // In perspective: t from 1 at the left to 0.25 at the right, a trapezium.
      g = cell(5, 1).graphics;
      g.beginBitmapFill(texture, null, false, true);
      g.drawTriangles(
        Vector.<Number>([0, 0, 50, 12, 50, 38, 0, 50]),
        corners,
        Vector.<Number>([0, 0, 1, 1, 0, 0.25, 1, 1, 0.25, 0, 1, 1])
      );

      // A solid fill with uvtData draws nothing, nor its lines; the rect after it does.
      g = cell(0, 2).graphics;
      g.lineStyle(2, 0xFF0000);
      g.beginFill(0x00FF00);
      g.drawTriangles(quad, corners, Vector.<Number>([0, 0, 1, 0, 1, 1, 0, 1]));
      g.lineStyle();
      g.beginFill(0x999999);
      g.drawRect(15, 15, 20, 20);
      g.endFill();

      // Textured with lines, in perspective the other way, not smoothed and repeating.
      g = cell(1, 2).graphics;
      g.lineStyle(2, 0x000000);
      g.beginBitmapFill(texture, null, true, false);
      g.drawTriangles(
        Vector.<Number>([0, 10, 50, 0, 50, 50, 0, 40]),
        corners,
        Vector.<Number>([0, 0, 0.5, 2, 0, 1, 2, 2, 1, 0, 2, 0.5])
      );

      // Under colour transforms: one with offsets, one that only multiplies.
      var offset:Shape = cell(2, 2);
      offset.graphics.beginBitmapFill(texture, null, false, false);
      offset.graphics.drawTriangles(quad, corners, Vector.<Number>([0, 0, 1, 0, 1, 1, 0, 1]));
      offset.transform.colorTransform = new ColorTransform(0.5, 1, 1, 1, 0, 0, 100, 0);
      var faded:Shape = cell(3, 2);
      faded.graphics.beginBitmapFill(texture, null, false, false);
      faded.graphics.drawTriangles(quad, corners, Vector.<Number>([0, 0, 1, 0, 1, 1, 0, 1]));
      faded.alpha = 0.5;

      // Turned, and glowing, of a texture of its own: Flash keeps a filter's output, and a
      // cached bitmap, though the texture changes.
      var turned:Shape = cell(4, 2);
      turned.graphics.beginBitmapFill(texture, null, false, true);
      turned.graphics.drawTriangles(Vector.<Number>([-20, -20, 20, -20, 20, 20, -20, 20]), corners,
        Vector.<Number>([0, 0, 1, 0, 1, 1, 0, 1]));
      turned.x += 25;
      turned.y += 25;
      turned.rotation = 30;
      var glowing:Shape = cell(5, 2);
      glowing.graphics.beginBitmapFill(texture.clone(), null, false, false);
      glowing.graphics.drawTriangles(Vector.<Number>([5, 5, 45, 5, 25, 45]), null, Vector.<Number>([0, 0, 1, 0, 0.5, 1]));
      glowing.filters = [new GlowFilter(0xFF00FF, 1, 6, 6, 2)];

      // Drawn into a BitmapData.
      var source:Shape = new Shape();
      source.graphics.beginBitmapFill(texture, null, false, true);
      source.graphics.drawTriangles(quad, corners, Vector.<Number>([0, 0, 1, 0, 1, 1, 0, 1]));
      source.graphics.lineStyle(2, 0x000000);
      source.graphics.drawTriangles(Vector.<Number>([10, 10, 40, 10, 25, 40]));
      var drawn:BitmapData = new BitmapData(50, 50, true, 0x00000000);
      drawn.draw(source);
      var shown:Bitmap = new Bitmap(drawn);
      shown.x = 10;
      shown.y = 220;
      addChild(shown);

      // drawGraphicsData's triangles, the same.
      var data:Shape = new Shape();
      data.x = 70;
      data.y = 220;
      data.graphics.drawGraphicsData(Vector.<IGraphicsData>([
        new GraphicsSolidFill(0x6633CC),
        new GraphicsTrianglePath(Vector.<Number>([0, 0, 50, 0, 0, 50]), null, null, "none")
      ]));
      addChild(data);

      // Textured triangles as a mask, which clips by their triangles.
      var masked:Shape = new Shape();
      masked.graphics.beginFill(0xFF3300);
      masked.graphics.drawRect(0, 0, 50, 50);
      masked.x = 140;
      masked.y = 220;
      addChild(masked);
      var mask:Shape = new Shape();
      mask.graphics.beginBitmapFill(texture, null, false, false);
      mask.graphics.drawTriangles(Vector.<Number>([0, 0, 50, 25, 0, 50]), null, Vector.<Number>([0, 0, 1, 0, 0, 1]));
      mask.x = 140;
      mask.y = 220;
      addChild(mask);
      masked.mask = mask;

      // Cached as a bitmap inside a scaled sprite, of a texture of its own as the glow's; and
      // mirrored.
      var cached:Sprite = new Sprite();
      var inner:Shape = new Shape();
      inner.graphics.beginBitmapFill(texture.clone(), null, false, false);
      inner.graphics.drawTriangles(quad, corners, Vector.<Number>([0, 0, 1, 0, 1, 1, 0, 1]));
      inner.cacheAsBitmap = true;
      cached.addChild(inner);
      cached.scaleX = cached.scaleY = 0.8;
      cached.x = 205;
      cached.y = 220;
      addChild(cached);
      var mirrored:Shape = new Shape();
      mirrored.graphics.beginBitmapFill(texture, null, false, false);
      mirrored.graphics.drawTriangles(quad, corners, Vector.<Number>([0, 0, 1, 0, 1, 1, 0, 1]));
      mirrored.scaleX = -1;
      mirrored.x = 320;
      mirrored.y = 220;
      addChild(mirrored);

      read("overlap", shapes[0]);
      read("culling", shapes[1]);
      read("lines", shapes[2]);
      read("fill and line", shapes[3]);
      read("pen", shapes[4]);
      read("contour", shapes[5]);
      read("matrix", shapes[6]);
      read("textured", shapes[7]);
      read("solid uvt", shapes[12]);
      read("textured lines", shapes[13]);
      errors();
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function cell(column:int, row:int):Shape {
      var s:Shape = new Shape();
      s.x = 10 + column * 65;
      s.y = 10 + row * 70;
      addChild(s);
      shapes.push(s);
      return s;
    }

    // The bounds with lines but where they are mitred, whose corners Flash counts and the player
    // does not; and readGraphicsData but for the contour, whose part after the triangles Flash
    // keeps from the pen to its start, and the player from its start through the pen.
    private function read(name:String, s:Shape):void {
      var bounds:String = name == "lines" ? "" : String(s.getBounds(s));
      if (name == "contour") {
        trace(name, bounds, s.getRect(s));
        return;
      }

      var out:Array = [];
      for each (var d:IGraphicsData in s.graphics.readGraphicsData(false)) {
        var n:String = getQualifiedClassName(d).split("::")[1].replace("Graphics", "");
        if (d is GraphicsPath) {
          var p:GraphicsPath = GraphicsPath(d);
          n += "(" + p.commands.join("") + (p.data.length <= 16 ? "|" + p.data.join(",") : "") + ")";
        }
        out.push(n);
      }
      trace(name, bounds, s.getRect(s), out.join(" "));
    }

    private function attempt(name:String, f:Function):void {
      try {
        f();
        trace(name, "no error");
      } catch (e:Error) {
        trace(name, e.errorID, getQualifiedClassName(e));
      }
    }

    private function errors():void {
      var g:Graphics = new Shape().graphics;
      var three:Vector.<Number> = Vector.<Number>([0, 0, 10, 0, 0, 10]);
      attempt("null vertices", function():void { g.drawTriangles(null); });
      attempt("odd vertices", function():void { g.drawTriangles(Vector.<Number>([0, 0, 10])); });
      attempt("two vertices", function():void { g.drawTriangles(Vector.<Number>([0, 0, 10, 0])); });
      attempt("indices of two", function():void { g.drawTriangles(three, Vector.<int>([0, 1])); });
      attempt("index past", function():void { g.drawTriangles(three, Vector.<int>([0, 1, 7])); });
      attempt("short uvt", function():void { g.drawTriangles(three, null, Vector.<Number>([0, 0, 1])); });
      attempt("uvt of three", function():void { g.drawTriangles(three, null, Vector.<Number>([0, 0, 1, 1, 0, 1, 0, 1, 1])); });
      attempt("bad culling", function():void { g.drawTriangles(three, null, null, "both"); });
      attempt("path culling", function():void { new GraphicsTrianglePath(three, null, null, "both"); });
    }

    private var frames:int = 0;

    private function frame(e:Event):void {
      if (++frames != 1) {
        return;
      }

      removeEventListener(Event.ENTER_FRAME, frame);
      // On the stage and drawn: what the hit tests find, through the triangles and not past them.
      var points:Array = [[0, 5, 5], [0, 45, 45], [1, 5, 5], [1, 40, 40], [1, 40, 5], [7, 25, 25], [12, 25, 25], [2, 1, 25]];
      for each (var at:Array in points) {
        var s:Shape = shapes[at[0]];
        trace("hit", at[0], at[1], at[2], s.hitTestPoint(s.x + at[1], s.y + at[2], true));
      }

      // The texture's change shows on the next frame.
      texture.fillRect(new Rectangle(0, 0, 2, 2), 0xFFFFFFFF);
    }
  }
}
