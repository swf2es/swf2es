package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Graphics;
  import flash.display.GraphicsPath;
  import flash.display.IGraphicsData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.filters.GlowFilter;
  import flash.geom.Matrix;
  import flash.geom.Point;
  import flash.utils.getQualifiedClassName;

  // drawTriangles' culling decided as the triangles turn on the screen, or
  // in a BitmapData's draw, as adl decides it: a mirror drops the other
  // side, a half turn and a mirrored Bitmap of an upright draw do not, and
  // a 3D turn neither, its content drawn in its own space. readGraphicsData
  // keeps the drawing's own, the hit tests the screen's. Each cell holds a
  // red triangle that turns clockwise on a y-down screen, at the top left,
  // and a blue one the other way round, at the bottom right, both culled
  // "positive"; or the same textured.
  public class DrawTrianglesCulling extends Sprite {
    private var texture:BitmapData;
    private var flipped:Shape;
    private var mirrored:Shape;
    private var lines:Shape;
    private var beneath:Shape;

    public function DrawTrianglesCulling() {
      texture = new BitmapData(4, 4, true, 0);
      for (var y:int = 0; y < 4; y++) {
        for (var x:int = 0; x < 4; x++) {
          texture.setPixel32(x, y, 0xFF000000 | (x * 80) << 16 | (y * 80) << 8 | (x + y) * 30);
        }
      }

      var s:Shape;
      // Row 0: upright; under a mirrored parent; turned half round; mirrored upside down; turned
      // in 3D; textured, mirrored.
      cull(at(0, 0), false);
      beneath = under(1, 0);
      cull(beneath, false);
      s = at(2, 0, 50, 50);
      s.rotation = 180;
      cull(s, false);
      s = at(3, 0, 0, 50);
      s.scaleY = -1;
      cull(s, false);
      s = at(4, 0, 25, 0);
      s.rotationY = 180;
      s.x += 25;
      cull(s, false);
      s = at(5, 0, 50, 0);
      s.scaleX = -1;
      cull(s, true);

      // Row 1: BitmapData.draw through a mirroring matrix, plain and textured; cached as a bitmap
      // under a mirror; filtered and textured under one; a mirrored Bitmap of an upright draw;
      // lines alone under a mirror.
      drawn(0, 1, false, true);
      drawn(1, 1, true, true);
      s = under(2, 1);
      cull(s, false);
      s.cacheAsBitmap = true;
      s = under(3, 1);
      cull(s, true);
      s.filters = [new GlowFilter(0x00FF00, 1, 4, 4, 2)];
      var b:Bitmap = drawn(4, 1, false, false);
      b.x += 50;
      b.scaleX = -1;
      lines = under(5, 1);
      lines.graphics.lineStyle(2, 0x000000);
      lines.graphics.drawTriangles(Vector.<Number>([0, 0, 45, 0, 0, 45, 50, 50, 50, 5, 5, 50]), null,
        null, "positive");

      // Row 2: mirrored on the second frame, after it was drawn upright, and the other way.
      flipped = at(0, 2);
      cull(flipped, false);
      mirrored = at(1, 2, 50, 0);
      mirrored.scaleX = -1;
      cull(mirrored, true);

      read("upright", shapes[0]);
      read("mirrored", mirrored);
      read("lines", lines);
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private var shapes:Array = [];

    private function at(column:int, row:int, dx:Number = 0, dy:Number = 0):Shape {
      var s:Shape = new Shape();
      s.x = 10 + column * 65 + dx;
      s.y = 10 + row * 70 + dy;
      addChild(s);
      shapes.push(s);
      return s;
    }

    // A Shape drawn first, then put in a sprite that mirrors it.
    private function under(column:int, row:int):Shape {
      var s:Shape = new Shape();
      var p:Sprite = new Sprite();
      p.x = 10 + column * 65 + 50;
      p.y = 10 + row * 70;
      p.scaleX = -1;
      addChild(p);
      p.addChild(s);
      return s;
    }

    private function drawn(column:int, row:int, textured:Boolean, mirror:Boolean):Bitmap {
      var source:Shape = new Shape();
      cull(source, textured);
      var data:BitmapData = new BitmapData(50, 50, true, 0);
      data.draw(source, mirror ? new Matrix(-1, 0, 0, 1, 50, 0) : null);
      var b:Bitmap = new Bitmap(data);
      b.x = 10 + column * 65;
      b.y = 10 + row * 70;
      addChild(b);
      return b;
    }

    private function cull(s:Shape, textured:Boolean):void {
      var g:Graphics = s.graphics;
      if (textured) {
        g.beginBitmapFill(texture, null, false, false);
        g.drawTriangles(Vector.<Number>([0, 0, 45, 0, 0, 45, 50, 50, 50, 5, 5, 50]), null,
          Vector.<Number>([0, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1]), "positive");
        return;
      }

      g.beginFill(0xCC0000);
      g.drawTriangles(Vector.<Number>([0, 0, 45, 0, 0, 45]), null, null, "positive");
      g.beginFill(0x0000CC);
      g.drawTriangles(Vector.<Number>([50, 50, 50, 5, 5, 50]), null, null, "positive");
      g.endFill();
    }

    private function read(name:String, s:Shape):void {
      var out:Array = [];
      for each (var d:IGraphicsData in s.graphics.readGraphicsData(false)) {
        var n:String = getQualifiedClassName(d).split("::")[1].replace("Graphics", "");
        if (d is GraphicsPath) {
          var p:GraphicsPath = GraphicsPath(d);
          n += "(" + p.commands.join("") + (p.data.length <= 16 ? "|" + p.data.join(",") : "") + ")";
        }
        out.push(n);
      }
      trace(name, s.getBounds(s), out.join(" "));
    }

    // In the shape's own space: (5, 5) is in the red triangle, (45, 45) in the blue.
    private function hits(name:String, s:Shape):void {
      for each (var p:Array in [[5, 5], [45, 45]]) {
        var g:Point = s.localToGlobal(new Point(p[0], p[1]));
        trace("hit", name, p[0], p[1], s.hitTestPoint(g.x, g.y, true));
      }
    }

    private var frames:int = 0;

    private function frame(e:Event):void {
      frames++;
      if (frames == 1) {
        hits("upright", shapes[0]);
        hits("mirrored", mirrored);
        hits("under a mirror", beneath);
        flipped.scaleX = -1;
        flipped.x += 50;
        mirrored.scaleX = 1;
        mirrored.x -= 50;
        return;
      }

      // Asked once the flips are drawn: adl hits a flip's triangles as it last drew them.
      removeEventListener(Event.ENTER_FRAME, frame);
      hits("flipped", flipped);
      hits("unmirrored", mirrored);
    }
  }
}
