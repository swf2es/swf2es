package {
  import flash.display.Sprite;
  import flash.globalization.LastOperationStatus;
  import flash.globalization.NationalDigitsType;
  import flash.globalization.NumberFormatter;
  import flash.globalization.NumberParseResult;

  // Locales named outright: what a default or fallback locale is depends on the machine.
  public class NumberFormatterNatives extends Sprite {
    public function NumberFormatterNatives() {
      var nf:NumberFormatter;
      for each (var id:String in ["en-US", "fi-FI", "de-DE", "ja-JP", "en_US", "EN-gb", "en", "de", "en-IN", "xx-YY", "en-ZZ", "", "i-default", "de-AT-1996"]) {
        nf = new NumberFormatter(id);
        trace(id, "|", nf.requestedLocaleIDName, nf.actualLocaleIDName, nf.lastOperationStatus,
          codes(nf.decimalSeparator), codes(nf.groupingSeparator), nf.groupingPattern, nf.fractionalDigits,
          nf.negativeNumberFormat, nf.negativeSymbol, nf.digitsType, nf.leadingZero, nf.trailingZeros, nf.useGrouping);
        trace("  ", nf.formatNumber(1234567.891), nf.formatNumber(-0.5), nf.formatInt(-1234), nf.formatUint(4000000000),
          nf.formatNumber(NaN), nf.formatNumber(Infinity), nf.formatNumber(-Infinity), nf.lastOperationStatus);
      }

      // Nine decimals, then rounded half up to the digits asked for.
      nf = new NumberFormatter("en-US");
      nf.fractionalDigits = 20;
      trace("p20", nf.formatNumber(1.123456789012345), nf.formatNumber(1 / 3), nf.formatNumber(123456789.125),
        nf.formatNumber(9.87654321e-5), nf.formatNumber(12345678901234567890), nf.formatNumber(5e-324));
      nf.fractionalDigits = 2;
      trace("p2", nf.formatNumber(0.005), nf.formatNumber(1.005), nf.formatNumber(2.675), nf.formatNumber(-0.004),
        nf.formatNumber(0.995), nf.formatNumber(99.995), nf.formatNumber(-0), nf.formatNumber(-1e-300),
        nf.formatNumber(1e21), nf.formatNumber(1e100));
      nf.fractionalDigits = 0;
      trace("p0", nf.formatNumber(0.5), nf.formatNumber(2.5), nf.formatNumber(-0.5), nf.formatNumber(0.49999999999999994),
        nf.formatNumber(-1e-10), nf.formatInt(int.MIN_VALUE), nf.formatUint(uint.MAX_VALUE));

      nf = new NumberFormatter("en-US");
      for each (var n:int in [-1, 0, 1, 5, 21]) {
        nf.fractionalDigits = n;
        trace("fractionalDigits", n, nf.fractionalDigits, nf.lastOperationStatus, nf.formatNumber(1.123456789));
      }

      nf = new NumberFormatter("en-US");
      for each (var k:uint in [0, 1, 2, 3, 4, 5, 2147483647, 2147483648, 4294967295]) {
        nf.negativeNumberFormat = k;
        trace("negativeNumberFormat", k, nf.negativeNumberFormat, nf.lastOperationStatus, nf.formatNumber(-12.5));
      }

      nf = new NumberFormatter("en-US");
      for each (var gp:String in ["3", "3;2", "3;2;*", "3;*", "1;*", "4;3;*", "3;2;1", "2;3;4;5;*", "1;2;3;4;5", "1;2;3;4;5;*", "1;2;3;4;5;6", "", "0;3", "x", "3;", ";3", "10;*", "3;0;*", "3;*;2", "3;**", "3 ;2", "03;*", "3;2;*;"]) {
        nf.groupingPattern = gp;
        trace("groupingPattern [" + gp + "]", nf.groupingPattern, nf.lastOperationStatus, nf.formatNumber(123456789012));
      }
      call("groupingPattern null", function():void { nf.groupingPattern = null; });

      nf = new NumberFormatter("en-US");
      nf.leadingZero = false;
      trace("leadingZero", nf.formatNumber(0.5), nf.formatNumber(-0.5), nf.formatNumber(0), nf.formatNumber(1.5));
      nf.fractionalDigits = 0;
      trace("leadingZero none", "[" + nf.formatNumber(0.4) + "]", "[" + nf.formatNumber(0) + "]");
      nf = new NumberFormatter("en-US");
      nf.trailingZeros = false;
      trace("trailingZeros", nf.formatNumber(0.5), nf.formatNumber(2), nf.formatNumber(2.1), nf.formatInt(5), nf.formatNumber(0));
      nf = new NumberFormatter("en-US");
      nf.useGrouping = false;
      trace("useGrouping", nf.formatNumber(1234567), nf.formatInt(-1234567), nf.lastOperationStatus);

      nf = new NumberFormatter("en-US");
      nf.decimalSeparator = "";
      trace("decimalSeparator empty", nf.decimalSeparator, nf.lastOperationStatus);
      nf.decimalSeparator = "@@";
      trace("decimalSeparator two", nf.decimalSeparator, nf.lastOperationStatus, nf.formatNumber(1.5));
      nf.groupingSeparator = "'";
      trace("groupingSeparator", nf.groupingSeparator, nf.lastOperationStatus, nf.formatNumber(1234567.5));
      nf.groupingSeparator = "";
      trace("groupingSeparator empty", nf.lastOperationStatus, nf.formatNumber(1234567.5));
      nf.negativeSymbol = "~";
      trace("negativeSymbol", nf.negativeSymbol, nf.lastOperationStatus, nf.formatNumber(-3));
      call("decimalSeparator null", function():void { nf.decimalSeparator = null; });
      call("groupingSeparator null", function():void { nf.groupingSeparator = null; });
      call("negativeSymbol null", function():void { nf.negativeSymbol = null; });

      nf = new NumberFormatter("en-US");
      for each (var digits:uint in [NationalDigitsType.EUROPEAN, NationalDigitsType.ARABIC_INDIC, NationalDigitsType.EXTENDED_ARABIC_INDIC,
          NationalDigitsType.DEVANAGARI, NationalDigitsType.THAI, NationalDigitsType.FULL_WIDTH, NationalDigitsType.MYANMAR, 49]) {
        nf.digitsType = digits;
        trace("digitsType", digits, nf.digitsType, nf.lastOperationStatus, nf.formatNumber(1234.5));
      }

      // Statuses: the methods and setters set it, the getters leave it.
      nf = new NumberFormatter("xx");
      trace("status", nf.lastOperationStatus, nf.useGrouping, nf.actualLocaleIDName, nf.lastOperationStatus);
      trace("status after format", nf.formatNumber(3), nf.lastOperationStatus);
      nf.fractionalDigits = -5;
      trace("status after a bad setter", nf.lastOperationStatus, nf.fractionalDigits, nf.lastOperationStatus);
      nf.fractionalDigits = 3;
      trace("status after a good one", nf.lastOperationStatus);

      nf = new NumberFormatter("en-US");
      for each (var neg:uint in [0, 1, 2, 3, 4]) {
        nf.negativeNumberFormat = neg;
        var out:Array = [];
        for each (var s:String in ["(5)", "-5", "5-", "- 5", "5 -", "+5", "x5", "5x", "(5", "5)", "-(5)", "--5", "5--", "a-5", " ( 5 ) ", "( 5)", "5 ", "\t5\n", "5 ", " 5", "(-5)", "((5))", "5..", "5.", "5,", ",5", "5.,1", "1,,2", "1.2,3"]) {
          var r:NumberParseResult = nf.parse(s);
          var st:String = nf.lastOperationStatus;
          out.push("[" + s + "]" + r.value + "," + r.startIndex + "," + r.endIndex + "," + st + "/" + nf.parseNumber(s) + "," + nf.lastOperationStatus);
        }
        trace("parse", neg, out.join(" "));
      }
      nf = new NumberFormatter("en-US");
      for each (s in ["123", " 123 ", "1,234.5", "-1,234.5", "abc", "", "   ", "12abc", "abc12", "1.2.3", "1e5", "0x10", ".5", "-.5", "1,2,3", "12,34", "٣.٥", "１２", "Infinity", "NaN", "  -42  ", "x-3y", "3 4"]) {
        r = nf.parse(s);
        st = nf.lastOperationStatus;
        trace("parse [" + s + "]", r.value, r.startIndex, r.endIndex, st, nf.parseNumber(s), nf.lastOperationStatus);
      }
      nf = new NumberFormatter("de-DE");
      for each (s in ["1.234,5", "1234,5", "1,5", "1.5", "-1.234,5"]) {
        r = nf.parse(s);
        trace("de parse [" + s + "]", r.value, r.startIndex, r.endIndex, nf.parseNumber(s), nf.lastOperationStatus);
      }
      call("parse null", function():void { nf.parse(null); });
      call("parseNumber null", function():void { nf.parseNumber(null); });
      call("constructor null", function():void { new NumberFormatter(null); });
      // Digits past Unicode's last are invalid, past int's range illegal; the value stays.
      nf = new NumberFormatter("en-US");
      for each (var zero:uint in [0x10000, 0x10FFF6, 0x10FFF7, 0x10FFFF, 0x110000, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF]) {
        nf.digitsType = 0x6F0;
        nf.digitsType = zero;
        trace("digitsType", zero.toString(16), nf.digitsType.toString(16), nf.lastOperationStatus);
      }
      nf.digitsType = 0;
      trace("digitsType zero [" + nf.formatNumber(-12.5) + "]");
      nf = new NumberFormatter("en-US");
      for each (var sep:String in ["a", "abc", "abcd", "\u00e9\u00e9\u00e9\u00e9"]) {
        nf.decimalSeparator = sep;
        var decimalStatus:String = nf.lastOperationStatus;
        nf.groupingSeparator = sep;
        trace("separator", sep, decimalStatus, nf.lastOperationStatus, nf.decimalSeparator, nf.groupingSeparator);
        nf.decimalSeparator = ".";
        nf.groupingSeparator = ",";
      }
      // A sign or parenthesis at most a space from the number; U+2212 a minus too.
      for each (var format:uint in [0, 1, 3, 4]) {
        nf.negativeNumberFormat = format;
        out = [];
        for each (s in ["-  5", "- 5", "5 -", "5  -", "(  5)", "( 5 )", "\u22125", "5\u2212", "-\u00a05", "12  -"]) {
          r = nf.parse(s);
          out.push("[" + s + "]" + r.value + "," + r.startIndex + "," + r.endIndex + "/" + nf.parseNumber(s));
        }
        trace("spaces", format, out.join(" "));
      }
      for each (id in ["nb-NO", "iw-IL", "in-ID", "tl", "und", "en--us", "en-US-", "en.US", "  en-US", "ja-JP-JP", "en-us-x-foo", "en-u-nu-arab", "de-1996", "C", "POSIX", "EN_us", "en@currency=EUR", "fil-PH", "zh-Hans-CN", "sr-Cyrl", "es-MX", "pt"]) {
        nf = new NumberFormatter(id);
        trace("locale [" + id + "]", nf.requestedLocaleIDName, nf.actualLocaleIDName, nf.lastOperationStatus);
      }
      // A surrogate or a noncharacter is no zero; a NUL ends a separator; signs stand only plain,
      // no-break, narrow or ideographic spaces from their number.
      nf = new NumberFormatter("en-US");
      for each (zero in [0xD800, 0xDC00, 0xDFFF, 0xFFFE, 0xFFFF, 0xE000]) {
        nf.digitsType = 0x6F0;
        nf.digitsType = zero;
        trace("digitsType", zero.toString(16), nf.digitsType.toString(16), nf.lastOperationStatus);
      }
      nf = new NumberFormatter("en-US");
      nf.decimalSeparator = "a\u0000b";
      nf.groupingSeparator = "c\u0000d";
      trace("separator nul", nf.decimalSeparator, nf.groupingSeparator, nf.lastOperationStatus, nf.formatNumber(1234.5));
      nf.decimalSeparator = "\u0000";
      trace("separator nul alone", nf.decimalSeparator, nf.lastOperationStatus);
      nf.groupingSeparator = "\u0000";
      trace("grouping nul alone [" + nf.groupingSeparator + "]", nf.lastOperationStatus);
      nf = new NumberFormatter("en-US");
      for each (s in [" ", "\u00a0", "\u2000", "\u2007", "\u2009", "\u202f", "\u3000", "\u205f", "\t"]) {
        r = nf.parse("-" + s + "5");
        trace("sign space", escape(s), r.value, r.startIndex, r.endIndex, nf.parseNumber("-" + s + "5"), nf.parseNumber(s + "5" + s));
      }
      trace("available", NumberFormatter.getAvailableLocaleIDNames().length > 0, LastOperationStatus.NO_ERROR);
    }

    private static function codes(s:String):String {
      var a:Array = [];
      for (var i:int = 0; i < s.length; i++) {
        a.push(s.charCodeAt(i).toString(16));
      }
      return a.join(" ");
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
