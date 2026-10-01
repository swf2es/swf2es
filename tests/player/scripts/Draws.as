// Drawing with Graphics: a Shape with fills and strokes of every kind of
// edge, and a Sprite drawn in under a child it holds, for the pixels; what
// Flash draws decides the fills' closing, the strokes' order and the
// rounded corners.
package {
  import flash.display.CapsStyle;
  import flash.display.GraphicsPathWinding;
  import flash.display.JointStyle;
  import flash.display.MovieClip;
  import flash.display.Shape;
  import flash.display.Sprite;

  public class Main extends MovieClip {
    private var wound:Shape;

    public function Main() {
      addFrameScript(1, frame2);
      var shape:Shape = new Shape();
      var g = shape.graphics;
      // A fill with a stroke begun inside it: the stroke draws over the fill.
      g.beginFill(0xff0000);
      g.lineStyle(4, 0x0000ff);
      g.drawRect(10, 10, 60, 40);
      g.lineStyle();
      // Two contours in one fill: the second cuts a hole (even-odd), and
      // the open triangle closes back to its start.
      g.beginFill(0x00aa00, 0.8);
      g.moveTo(90, 10);
      g.lineTo(150, 10);
      g.lineTo(120, 50);
      g.moveTo(110, 20);
      g.lineTo(130, 20);
      g.lineTo(120, 35);
      g.endFill();
      // Curves: a rounded rectangle, a circle, an ellipse and a cubic.
      g.beginFill(0x8800ff);
      g.drawRoundRect(10, 60, 60, 30, 20, 10);
      g.drawCircle(100, 75, 15);
      g.drawEllipse(125, 60, 40, 30);
      g.endFill();
      // An even width: Flash snaps an odd one to whole pixels, half a pixel
      // off the geometry, which the renderer does not do yet.
      g.lineStyle(4, 0x000000, 1, false, "normal", CapsStyle.SQUARE, JointStyle.MITER);
      g.moveTo(170, 10);
      g.cubicCurveTo(200, 10, 170, 50, 195, 50);
      g.lineTo(195, 90);
      g.lineStyle();
      addChild(shape);

      // A square inside another, both the same way round: the winding rule
      // says whether the inner is filled (non-zero) or a hole (even-odd).
      wound = new Shape();
      wound.graphics.beginFill(0x009999);
      wound.graphics.drawPath(
        Vector.<int>([1, 2, 2, 2, 1, 2, 2, 2]),
        Vector.<Number>([0, 0, 30, 0, 30, 30, 0, 30, 10, 10, 20, 10, 20, 20, 10, 20]),
        GraphicsPathWinding.NON_ZERO);
      wound.graphics.endFill();
      wound.graphics.beginFill(0x990099);
      wound.graphics.drawPath(
        Vector.<int>([1, 2, 2, 2, 1, 2, 2, 2]),
        Vector.<Number>([40, 0, 70, 0, 70, 30, 40, 30, 50, 10, 60, 10, 60, 20, 50, 20]),
        GraphicsPathWinding.EVEN_ODD);
      wound.graphics.endFill();
      wound.x = 10;
      wound.y = 100;
      addChild(wound);

      // One fill, two paths with different rules: each path keeps its own,
      // so the first inner square is a hole and the second is filled.
      var mixed:Shape = new Shape();
      mixed.graphics.beginFill(0x336699);
      mixed.graphics.drawPath(
        Vector.<int>([1, 2, 2, 2, 1, 2, 2, 2]),
        Vector.<Number>([0, 0, 30, 0, 30, 30, 0, 30, 10, 10, 20, 10, 20, 20, 10, 20]),
        GraphicsPathWinding.EVEN_ODD);
      mixed.graphics.drawPath(
        Vector.<int>([1, 2, 2, 2, 1, 2, 2, 2]),
        Vector.<Number>([40, 0, 70, 0, 70, 30, 40, 30, 50, 10, 60, 10, 60, 20, 50, 20]),
        GraphicsPathWinding.NON_ZERO);
      mixed.graphics.endFill();
      mixed.x = 140;
      mixed.y = 100;
      addChild(mixed);

      // Copied from itself: Flash clears first and copies nothing, so it is not drawn.
      var copied:Shape = new Shape();
      copied.graphics.beginFill(0x996600);
      copied.graphics.drawRect(0, 0, 30, 30);
      copied.graphics.endFill();
      copied.graphics.copyFrom(copied.graphics);
      copied.x = 100;
      copied.y = 100;
      addChild(copied);

      // A sprite's drawing goes under its child.
      var sprite:Sprite = new Sprite();
      sprite.graphics.beginFill(0xffcc00);
      sprite.graphics.drawRect(0, 0, 50, 50);
      sprite.graphics.endFill();
      var child:Shape = new Shape();
      child.graphics.beginFill(0x0000ff);
      child.graphics.drawRect(10, 10, 20, 20);
      child.graphics.endFill();
      sprite.addChild(child);
      sprite.x = 140;
      sprite.y = 45;
      sprite.rotation = 15;
      addChild(sprite);
      // A shape never added, scaled: its size is scaled all the same.
      var lone:Shape = new Shape();
      lone.graphics.beginFill(0x333333);
      lone.graphics.drawRect(0, 0, 10, 10);
      lone.graphics.endFill();
      lone.scaleX = 2;
      lone.scaleY = 3;
      // The rectangle without the lines' widths, and the turned sprite's size: Flash's
      // bounds of lines are half a pixel wider than their geometry, by a rule not known.
      trace("drawn", shape.getRect(shape), sprite.width, sprite.height, lone.width, lone.height);
    }

    private function frame2():void {
      // Hit-tested by shape once drawn: the ring of the non-zero square, its inner square, and the even-odd one's inner square.
      trace("hit", wound.hitTestPoint(10 + 5, 100 + 5, true), wound.hitTestPoint(10 + 15, 100 + 15, true), wound.hitTestPoint(10 + 55, 100 + 15, true));
    }
  }
}
