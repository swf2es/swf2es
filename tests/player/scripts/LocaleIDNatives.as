package {
  import flash.display.Sprite;
  import flash.globalization.LocaleID;

  public class LocaleIDNatives extends Sprite {
    public function LocaleIDNatives() {
      for each (var id:String in ["en-US", "en_US", "zh-Hant-TW", "sr-Latn-RS", "en-US-POSIX", "de-DE@collation=phonebook",
          "ja-JP@calendar=japanese;currency=JPY", "ar-EG", "he-IL", "fa", "ur-PK", "xx-YY", "", "i-default", "en", "EN-us",
          "x-private", "en-US-u-ca-gregory", "zh-Hans", "123", "de-AT-1996", "en--US", "es-419", "a-b-c-d", "toolong-XX"]) {
        var l:LocaleID = new LocaleID(id);
        var kv:Object = l.getKeysAndValues();
        var pairs:Array = [];
        for (var k:String in kv) {
          pairs.push(k + "=" + kv[k]);
        }
        pairs.sort();
        trace("[" + id + "]", l.name, l.lastOperationStatus, "language=" + l.getLanguage(), "script=" + l.getScript(),
          "region=" + l.getRegion(), "variant=" + l.getVariant(), "rtl=" + l.isRightToLeft(), "keys=" + pairs.join(";"), l.lastOperationStatus);
      }

      for each (var want:Array in [[["fr-CA", "en-US"], ["en-US", "fr-FR", "de-DE"]], [["de-CH", "fr"], ["de-DE", "fr-FR", "it-IT"]],
          [["xx"], ["en-US", "fr-FR"]], [[], ["en-US"]], [["en-GB", "en"], ["en-US", "en-GB", "en"]], [["zh-TW"], ["zh-CN", "zh-Hant", "zh-TW"]]]) {
        var preferred:Vector.<String> = LocaleID.determinePreferredLocales(Vector.<String>(want[0]), Vector.<String>(want[1]));
        trace("preferred", want[0].join(","), "/", want[1].join(","), "=>", preferred.join(","), preferred.length);
      }
      for each (id in ["zh-TW", "sgn-BE-FR", "abcdefghi-XX", "de@x=1", "und", "de-DE-1996", "EN_us", "iw", "en-US@collation=phonebook;currency=EUR"]) {
        l = new LocaleID(id);
        trace("[" + id + "]", l.name, l.getLanguage(), "script=" + l.getScript(), "region=" + l.getRegion(), "variant=" + l.getVariant(), l.isRightToLeft());
      }
      for each (want in [[["en-GB", "en"], ["en-US", "en-GB", "en"]], [["en", "en-GB"], ["en-US", "en-GB", "en"]], [["en-AU"], ["en-GB", "en-US", "en", "en-AU"]],
          [["en"], ["en-GB", "en-AU", "en-US", "en"]], [["pt"], ["pt-PT", "pt-BR", "pt"]], [["de-AT"], ["de", "de-DE", "de-CH"]], [["fr-CA"], ["fr", "fr-FR", "fr-Latn-CA", "fr-CA"]],
          [["zh-HK"], ["zh-Hant-HK", "zh-HK", "zh-CN"]], [["fr-CA", "en", "zh-TW", "pt-PT", "de"], ["en-US", "fr-FR", "fr", "zh-CN", "zh-Hant-HK", "pt-BR", "de-DE", "en-GB", "en", "fr-CA", "EN-us", "", "x"]]]) {
        preferred = LocaleID.determinePreferredLocales(Vector.<String>(want[0]), Vector.<String>(want[1]));
        trace("preferred", want[0].join(","), "/", want[1].join(","), "=>", preferred.join(","));
      }
      trace("null elements", LocaleID.determinePreferredLocales(new <String>[null, "en"], new <String>[null, "en"]).join(","));
      trace("keyword", LocaleID.determinePreferredLocales(new <String>["fr-FR"], new <String>["fr-FR"], "").join(","));
      call("want null", function():void { LocaleID.determinePreferredLocales(null, new <String>["en-US"]); });
      call("have null", function():void { LocaleID.determinePreferredLocales(new <String>["en-US"], null); });
      call("keyword null", function():void { LocaleID.determinePreferredLocales(new <String>["en-US"], new <String>["fr-FR"], null); });
      call("constructor null", function():void { new LocaleID(null); });
      trace("default", LocaleID.DEFAULT);
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
