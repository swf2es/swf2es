package {
  import flash.display.*;

  // A half-clear line where it overlaps itself: drawTriangles' outlines,
  // which adl keeps as one path, are filled once where triangles share an
  // edge or a corner; a line's paths, each begun by a move, are blended
  // over each other where they overlap, each filled once.
  public class LineOverlaps extends Sprite {
    public function LineOverlaps() {
      var s:Shape = new Shape();
      s.x = 10;
      s.y = 10;
      s.graphics.lineStyle(6, 0x000000, 0.5);
      s.graphics.drawTriangles(Vector.<Number>([0, 0, 60, 0, 60, 60, 0, 60]), Vector.<int>([0, 1, 2, 0, 2, 3]));
      addChild(s);
      // The same square's two triangles as paths of one line.
      var t:Shape = new Shape();
      t.x = 100;
      t.y = 10;
      t.graphics.lineStyle(6, 0x000000, 0.5);
      t.graphics.moveTo(0, 0);
      t.graphics.lineTo(60, 0);
      t.graphics.lineTo(60, 60);
      t.graphics.lineTo(0, 0);
      t.graphics.moveTo(0, 0);
      t.graphics.lineTo(60, 60);
      t.graphics.lineTo(0, 60);
      t.graphics.lineTo(0, 0);
      addChild(t);
      trace("drawn");
    }
  }
}
