// Drawing with Graphics: a Shape with fills and strokes of every kind of
// edge, and a Sprite drawn in under a child it holds, for the pixels; what
// Flash draws decides the fills' closing, the strokes' order and the
// rounded corners.
package {
  import flash.display.CapsStyle;
  import flash.display.JointStyle;
  import flash.display.MovieClip;
  import flash.display.Shape;
  import flash.display.Sprite;

  public class Main extends MovieClip {
    public function Main() {
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
      // The sizes (188.9 83.9 61.25 61.25 in Flash) wait for bounds.
      trace("drawn");
    }
  }
}
