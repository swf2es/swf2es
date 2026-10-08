package {
  import flash.globalization.CurrencyFormatter;
  import flash.globalization.CurrencyParseResult;
  import flash.display.Sprite;

  // Locales named outright: what a default or fallback locale is depends on the machine.
  public class CurrencyFormatterNatives extends Sprite {
    public function CurrencyFormatterNatives() {
      var cf:CurrencyFormatter;
      for each (var id:String in ["en-US", "fi-FI", "de-DE", "ja-JP", "en-GB", "nl-NL", "pt-BR", "zh-CN", "ko-KR", "sv-SE", "en", "xx"]) {
        cf = new CurrencyFormatter(id);
        trace(id, "|", cf.requestedLocaleIDName, cf.actualLocaleIDName, cf.lastOperationStatus, cf.currencyISOCode, cf.currencySymbol,
          cf.fractionalDigits, cf.negativeCurrencyFormat, cf.positiveCurrencyFormat, cf.negativeSymbol, cf.leadingZero, cf.trailingZeros);
        trace("  ", cf.format(1234.5), "|", cf.format(-1234.5), "|", cf.format(1234.5, true), "|", cf.format(-1234.5, true), cf.lastOperationStatus);
      }

      cf = new CurrencyFormatter("en-US");
      for each (var p:uint in [0, 1, 2, 3, 4, 2147483648]) {
        cf.positiveCurrencyFormat = p;
        trace("positiveCurrencyFormat", p, cf.positiveCurrencyFormat, cf.lastOperationStatus, cf.format(5, true), cf.format(5));
      }
      for (var n:uint = 0; n <= 16; n++) {
        cf.negativeCurrencyFormat = n;
        trace("negativeCurrencyFormat", n, cf.negativeCurrencyFormat, cf.lastOperationStatus, cf.format(-5, true), cf.format(-5));
      }
      cf.negativeCurrencyFormat = 4294967295;
      trace("negativeCurrencyFormat -1", cf.negativeCurrencyFormat, cf.lastOperationStatus);

      cf = new CurrencyFormatter("en-US");
      for each (var pair:Array in [["EUR", "€"], ["XYZ", "Q"], ["eur", "x"], ["EU1", "x"], ["", "x"], ["ABCD", "x"], ["JPY", ""], ["JPY", "¥"]]) {
        cf.setCurrency(pair[0], pair[1]);
        trace("setCurrency", pair[0], cf.lastOperationStatus, cf.currencyISOCode, "[" + cf.currencySymbol + "]", cf.fractionalDigits,
          cf.format(3.5, true), cf.format(3.5), cf.formattingWithCurrencySymbolIsSafe("JPY"), cf.formattingWithCurrencySymbolIsSafe("USD"));
      }
      call("setCurrency null code", function():void { cf.setCurrency(null, "x"); });
      call("setCurrency null symbol", function():void { cf.setCurrency("USD", null); });
      call("safe null", function():void { cf.formattingWithCurrencySymbolIsSafe(null); });
      cf = new CurrencyFormatter("fi-FI");
      trace("safe", cf.formattingWithCurrencySymbolIsSafe("EUR"), cf.formattingWithCurrencySymbolIsSafe("USD"), cf.formattingWithCurrencySymbolIsSafe("eur"), cf.lastOperationStatus);

      cf = new CurrencyFormatter("en-US");
      cf.negativeSymbol = "~";
      trace("negativeSymbol", cf.negativeSymbol, cf.lastOperationStatus);
      cf.decimalSeparator = ",";
      cf.groupingSeparator = ".";
      cf.fractionalDigits = 3;
      cf.groupingPattern = "3;2;*";
      cf.leadingZero = false;
      cf.trailingZeros = false;
      trace("settings", cf.lastOperationStatus, cf.format(-1234567.5, true), "[" + cf.format(0.25) + "]", "[" + cf.format(0) + "]");
      cf.digitsType = 1632;
      trace("digitsType", cf.lastOperationStatus, cf.format(12.5, true));
      cf = new CurrencyFormatter("en-US");
      trace("format", cf.format(0.005, true), cf.format(1.005, true), cf.format(-0.004, true), cf.format(1e21, true), cf.format(NaN), cf.format(Infinity, true), cf.format(-Infinity));

      cf = new CurrencyFormatter("en-US");
      parse(cf, ["$123.45", "$ 123.45", "123.45$", "123.45", "USD 123.45", "123.45 USD", "($123.45)", "-$123.45", "$-123.45", "$1,234.5", "€5", "abc", "", "  $5  ", "$5x", "EUR5", "5 EUR", "(5)", "-5"]);
      cf.negativeCurrencyFormat = 1;
      parse(cf, ["-$5", "$-5", "($5)", "- $ 5", "-5", "-USD5"]);
      cf.negativeCurrencyFormat = 8;
      parse(cf, ["-5 $", "-5$", "5 $-", "-5", "- 5 $"]);
      cf.positiveCurrencyFormat = 3;
      parse(cf, ["5 $", "5$", "$5", "5 US Dollar", "5 $$", "5 1$"]);
      cf = new CurrencyFormatter("de-DE");
      parse(cf, ["1.234,50 €", "1.234,50€", "-1.234,50 €", "€ 5", "5 EUR", "5"]);
      call("parse null", function():void { cf.parse(null); });
      call("constructor null", function():void { new CurrencyFormatter(null); });
      for each (id in ["es-419", "en-150"]) {
        cf = new CurrencyFormatter(id);
        trace(id, "|", cf.actualLocaleIDName, cf.currencyISOCode, "[" + cf.currencySymbol + "]", cf.positiveCurrencyFormat, cf.negativeCurrencyFormat,
          "[" + cf.format(1234.5, true) + "]", "[" + cf.format(-1234.5) + "]");
      }
      cf = new CurrencyFormatter("en-US");
      parse(cf, ["$.5", "$12.", "$1,2,3", "( $12 )", "$ ( 12 )", "-$-12"]);
      trace("available", CurrencyFormatter.getAvailableLocaleIDNames().length > 0);
    }

    private static function parse(cf:CurrencyFormatter, strings:Array):void {
      for each (var s:String in strings) {
        var r:CurrencyParseResult = cf.parse(s);
        trace("parse", cf.negativeCurrencyFormat, cf.positiveCurrencyFormat, "[" + s + "]", r.value, "[" + r.currencyString + "]", cf.lastOperationStatus);
      }
    }

    private static function call(name:String, f:Function):void {
      try {
        f();
        trace(name, "ok");
      } catch (e:Error) {
        trace(name, e.toString());
      }
    }
  }
}
