package {
  import flash.display.*;
  import flash.text.TextField;

  // A text field whose box is inset from its origin: x and y read, and set,
  // its box's corner, scaled, as a script centring a label on a button sets them.
  public class FieldPosition extends Sprite {
    private static function box(r:Object):String {
      return [r.x, r.y, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100].join(" ");
    }

    public function FieldPosition() {
      var field:TextField = getChildAt(0) as TextField;
      trace(field.x, field.y, box(field.getBounds(this)));
      field.x = 100;
      field.y = 50;
      trace(field.x, field.y, box(field.getBounds(this)), field.transform.matrix.tx, field.transform.matrix.ty);
      field.scaleX = 2;
      field.x = 100;
      trace(field.x, field.transform.matrix.tx);
    }
  }
}
