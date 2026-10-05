package {
  import flash.display.Sprite;
  import flash.globalization.CurrencyParseResult;

  public class CurrencyParseResultNatives extends Sprite {
    public function CurrencyParseResultNatives() {
      var ordinary:CurrencyParseResult = new CurrencyParseResult(12.5, "EUR");
      trace("ordinary", ordinary.value, ordinary.currencyString);

      try {
        var nullSymbol:CurrencyParseResult = new CurrencyParseResult(NaN, null);
        trace("null symbol", isNaN(nullSymbol.value), nullSymbol.currencyString === null);
      } catch (error:Error) {
        trace("null symbol", error.toString());
      }

      var negativeZero:CurrencyParseResult = new CurrencyParseResult(-0, "");
      trace("negative zero", 1 / negativeZero.value, negativeZero.currencyString.length);

    }
  }
}
