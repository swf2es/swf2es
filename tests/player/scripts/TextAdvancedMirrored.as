package {
  import flash.display.*;
  import flash.geom.*;
  import flash.text.*;

  public class TextAdvancedMirrored extends Sprite {
    public function TextAdvancedMirrored() {
      // Flash keeps advanced antialiasing when both axes are reflected.
      // Its quads need their coverage beyond the outline at small sizes too.
      var transforms:Array = [
        new Matrix(),
        new Matrix(-1, 0, 0, -1)
      ];
      var scales:Array = [0.4, 0.8, 1.6];
      for (var row:int = 0; row < transforms.length; row++) {
        for (var col:int = 0; col < scales.length; col++) {
          var field:TextField = new TextField();
          field.embedFonts = true;
          field.antiAliasType = AntiAliasType.ADVANCED;
          field.gridFitType = GridFitType.NONE;
          field.defaultTextFormat = new TextFormat("Stem", 18, 0);
          field.autoSize = TextFieldAutoSize.LEFT;
          field.text = "123456 m";
          var holder:Sprite = new Sprite();
          holder.addChild(field);
          var matrix:Matrix = transforms[row].clone();
          matrix.scale(scales[col], scales[col]);
          matrix.tx = col * 120 + (row == 0 ? 10 : 100);
          matrix.ty = row * 80 + (row == 0 ? 10 : 60);
          holder.transform.matrix = matrix;
          addChild(holder);
        }
      }

      trace("mirrored", numChildren);
    }
  }
}
