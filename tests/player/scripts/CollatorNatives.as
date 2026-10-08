package {
  import flash.display.Sprite;
  import flash.globalization.Collator;
  import flash.globalization.CollatorMode;

  // Pairs whose order ICU and Windows agree on: kana, widths and ß they do not.
  public class CollatorNatives extends Sprite {
    public function CollatorNatives() {
      var pairs:Array = [["a", "b"], ["a", "A"], ["a", "á"], ["ä", "z"], ["ö", "o"], ["w", "v"], ["file10", "file9"],
        ["a-b", "ab"], ["a b", "ab"], ["", "a"], ["", ""], ["co-op", "coop"], ["it's", "its"], ["résumé", "resume"],
        ["ll", "l"], ["z", "å"], ["a", "a"], ["B", "a"], ["10", "9"], ["!", "a"], ["Ａ", "A"]];
      for each (var id:String in ["en-US", "fi-FI", "de-DE", "sv-SE", "xx", "", "i-default"]) {
        for each (var mode:String in [CollatorMode.SORTING, CollatorMode.MATCHING]) {
          var c:Collator = new Collator(id, mode);
          trace(id, mode, "|", c.requestedLocaleIDName, c.actualLocaleIDName, c.lastOperationStatus, c.ignoreCase, c.ignoreDiacritics,
            c.ignoreKanaType, c.ignoreSymbols, c.ignoreCharacterWidth, c.numericComparison);
          var out:Array = [];
          for each (var pair:Array in pairs) {
            out.push(pair[0] + "/" + pair[1] + "=" + c.compare(pair[0], pair[1]) + (c.equals(pair[0], pair[1]) ? "T" : "F"));
          }
          trace("  ", out.join(" "), c.lastOperationStatus);
        }
      }

      var words:Array = ["b", "A", "a", "B", "á", "Á", "file10", "file9", "file1", "co-op", "coop", "Co-op", "-x", "x", "X"];
      for each (var option:String in ["", "ignoreCase", "ignoreDiacritics", "ignoreSymbols", "ignoreCharacterWidth", "ignoreKanaType", "numericComparison"]) {
        c = new Collator("en-US");
        if (option) {
          c[option] = true;
          trace("set", option, c[option], c.lastOperationStatus);
        }
        var sorted:Array = words.slice();
        var by:Collator = c;
        sorted.sort(function(x:String, y:String):int { return by.compare(x, y); });
        var steps:Array = [];
        for (var i:int = 0; i < sorted.length - 1; i++) {
          steps.push(by.compare(sorted[i], sorted[i + 1]));
        }
        trace("sort", option, sorted.join(","), steps.join(""), by.lastOperationStatus);
      }

      c = new Collator("en-US");
      c.ignoreCharacterWidth = true;
      trace("width", c.compare("ａｂ", "ab"), c.compare("ｱ", "ア"));
      c = new Collator("ja-JP");
      c.ignoreKanaType = true;
      trace("kana", c.compare("あ", "ア"), c.compare("かな", "カナ"));

      c = new Collator("en-US");
      c.numericComparison = true;
      trace("numeric", c.lastOperationStatus, c.numericComparison, c.compare("file10", "file9"), c.lastOperationStatus);
      c.numericComparison = false;
      trace("numeric off", c.lastOperationStatus, c.ignoreCase, c.lastOperationStatus);
      c = new Collator("xx");
      trace("status", c.lastOperationStatus, c.ignoreCase, c.lastOperationStatus, c.equals("a", "a"), c.lastOperationStatus);

      call("mode", function():void { new Collator("en-US", "foo"); });
      call("mode null", function():void { new Collator("en-US", null); });
      call("constructor null", function():void { new Collator(null); });
      call("compare null", function():void { c.compare(null, "a"); });
      call("compare null second", function():void { c.compare("a", null); });
      call("equals null", function():void { c.equals(null, "a"); });
      c = new Collator("en-US");
      trace("sharp s", c.compare("\u00df", "ss"), c.equals("Stra\u00dfe", "Strasse"));
      c.ignoreSymbols = true;
      trace("symbols", c.compare("$1", "1"), c.compare("a-b", "ab"), c.compare("a!b", "ab"), c.compare("@", "#"));
      trace("available", Collator.getAvailableLocaleIDNames().length > 0);
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
