package {
  import flash.display.Sprite;
  import flash.globalization.NumberParseResult;

  public class NumberParseResultNatives extends Sprite {
    public function NumberParseResultNatives() {
      var ordinary:NumberParseResult = new NumberParseResult(12.5, 2, 6);
      trace("ordinary", ordinary.value, ordinary.startIndex, ordinary.endIndex);

      var unusual:NumberParseResult = new NumberParseResult(NaN, -1, -5);
      trace("unusual", isNaN(unusual.value), unusual.startIndex, unusual.endIndex);

      var negativeZero:NumberParseResult = new NumberParseResult(-0, 0, 0);
      trace("negative zero", 1 / negativeZero.value, negativeZero.startIndex, negativeZero.endIndex);
    }
  }
}
