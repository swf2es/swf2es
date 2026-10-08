package {
  import flash.display.Sprite;
  import flash.globalization.DateTimeFormatter;
  import flash.globalization.DateTimeNameContext;
  import flash.globalization.DateTimeNameStyle;
  import flash.globalization.DateTimeStyle;

  // Locales named outright, and times formatted as UTC's: what a default
  // locale or a local time is depends on the machine.
  public class DateTimeFormatterNatives extends Sprite {
    public function DateTimeFormatterNatives() {
      var d:Date = new Date(Date.UTC(2024, 0, 5, 3, 4, 5, 6));
      var d2:Date = new Date(Date.UTC(1999, 10, 21, 15, 30, 59, 987));
      var d3:Date = new Date(Date.UTC(5, 6, 7, 0, 0, 0, 0));
      var f:DateTimeFormatter;
      var styles:Array = [DateTimeStyle.LONG, DateTimeStyle.MEDIUM, DateTimeStyle.SHORT, DateTimeStyle.NONE];
      for each (var id:String in ["en-US", "de-DE", "ja-JP", "en-GB", "fr-FR", "zh-CN", "fi-FI", "xx"]) {
        f = new DateTimeFormatter(id);
        // ICU's Finnish weekdays are not Windows': "sunnuntai" for "sunnuntaina"; nor are German abbreviations.
        var weekdays:Boolean = id != "fi-FI" && id != "de-DE";
        trace(id, "|", f.requestedLocaleIDName, f.actualLocaleIDName, f.lastOperationStatus, f.getDateStyle(), f.getTimeStyle(), f.getFirstWeekday());
        for each (var ds:String in styles) {
          for each (var ts:String in styles) {
            f.setDateTimeStyles(ds, ts);
            var named:Boolean = weekdays || ds == DateTimeStyle.SHORT || ds == DateTimeStyle.NONE;
            trace("  ", ds, ts, "[" + f.getDateTimePattern() + "]", "[" + (named ? f.formatUTC(d2) : "") + "]", f.lastOperationStatus);
          }
        }
        trace("  months", f.getMonthNames().join("|"), "/", f.getMonthNames(DateTimeNameStyle.FULL, DateTimeNameContext.FORMAT).join("|"));
        trace("  months abbreviated", f.getMonthNames(DateTimeNameStyle.LONG_ABBREVIATION).join("|"), "/",
          f.getMonthNames(DateTimeNameStyle.SHORT_ABBREVIATION, DateTimeNameContext.FORMAT).join("|"));
        if (weekdays) {
          trace("  weekdays", f.getWeekdayNames().join("|"), "/", f.getWeekdayNames(DateTimeNameStyle.LONG_ABBREVIATION).join("|"), "/",
            f.getWeekdayNames(DateTimeNameStyle.SHORT_ABBREVIATION, DateTimeNameContext.FORMAT).join("|"));
        }
      }

      f = new DateTimeFormatter("en-US");
      for each (var p:String in ["dd/MM/yyyy", "y", "yy", "yyy", "yyyyy", "yyyyyyyy", "M", "MM", "MMM", "MMMM", "MMMMM", "MMMMMM",
          "d", "dd", "ddd", "E", "EEE", "EEEE", "EEEEE", "EEEEEE", "a", "aa", "h", "hh", "hhh", "H", "HH", "K", "KK", "k", "kk",
          "m", "mm", "mmm", "s", "ss", "S", "SSS", "D", "z", "zzzz", "Z", "v", "Q", "w", "W", "F", "e", "c", "L", "u", "x", "Y",
          "'quoted'", "''", "'it''s'", "'unterminated", "yyyy-MM-dd'T'HH:mm:ss.SSS", "[yyyy] #@! é", "MMMMd", "", " ",
          "SSS yyyy D", "ddd SSS", "ddd q", "hh 'a''b' MMMMMMM"]) {
        f.setDateTimePattern(p);
        trace("pattern [" + p + "]", f.lastOperationStatus, "[" + f.getDateTimePattern() + "]", f.getDateStyle(), f.getTimeStyle(),
          "[" + f.formatUTC(d) + "]", "[" + f.formatUTC(d2) + "]", "[" + f.formatUTC(d3) + "]", f.lastOperationStatus);
      }

      // A month's genitive beside a day.
      f = new DateTimeFormatter("fi-FI");
      for each (p in ["MMMM d", "d MMMM", "d. MMMM", "MMMM yyyy", "dd MMMM", "MMMM, d", "MMMM", "'d' MMMM", "H MMMM", "MMMM 'x' d", "d MMM", "yyyy d MMMM", "MMMMM d", "dMMMM", "a"]) {
        f.setDateTimePattern(p);
        trace("fi [" + p + "]", f.formatUTC(d));
      }

      var local:Date = new Date(2024, 5, 15, 13, 14, 15);
      f = new DateTimeFormatter("en-US");
      f.setDateTimePattern("yyyy-MM-dd HH:mm:ss");
      trace("local", f.format(local) == "2024-06-15 13:14:15", f.lastOperationStatus);
      trace("invalid date [" + f.formatUTC(new Date(NaN)) + "]", f.lastOperationStatus);

      // Statuses: every method sets it, the getters leave it.
      f.setDateTimePattern("ddd");
      trace("status", f.lastOperationStatus, f.actualLocaleIDName, f.lastOperationStatus, f.getFirstWeekday(), f.lastOperationStatus);
      f.setDateTimePattern("ddd");
      trace("status pattern", f.getDateTimePattern(), f.lastOperationStatus);
      f.setDateTimePattern("ddd");
      trace("status names", f.getMonthNames().length, f.lastOperationStatus);
      f.setDateTimePattern("ddd");
      trace("status style", f.getDateStyle(), f.lastOperationStatus);
      f.setDateTimePattern("yyyy");
      f.setDateTimeStyles("short", "none");
      trace("styles after a pattern", f.getDateTimePattern(), f.getDateStyle(), f.getTimeStyle(), f.lastOperationStatus);
      for each (var pair:Array in [["long", "custom"], ["custom", "long"], ["foo", "long"], ["long", "foo"], ["LONG", "long"], ["", "none"]]) {
        call("styles " + pair.join(","), function():void {
          f.setDateTimeStyles(pair[0], pair[1]);
          trace("  ", f.lastOperationStatus, f.getDateStyle(), f.getTimeStyle());
        });
      }

      call("styles null date", function():void { f.setDateTimeStyles(null, "long"); });
      call("styles null time", function():void { f.setDateTimeStyles("long", null); });
      call("pattern null", function():void { f.setDateTimePattern(null); });
      call("formatUTC null", function():void { f.formatUTC(null); });
      call("format null", function():void { f.format(null); });
      call("months bad style", function():void { f.getMonthNames("foo"); });
      call("months bad context", function():void { f.getMonthNames("full", "foo"); });
      call("months null", function():void { f.getMonthNames(null); });
      call("weekdays null context", function():void { f.getWeekdayNames("full", null); });
      call("weekdays bad style", function():void { f.getWeekdayNames("FULL"); });
      call("constructor bad style", function():void { new DateTimeFormatter("en-US", "foo", "long"); });
      call("constructor custom style", function():void { new DateTimeFormatter("en-US", "custom", "long"); });
      call("constructor null style", function():void { new DateTimeFormatter("en-US", null, "long"); });
      call("constructor null", function():void { new DateTimeFormatter(null); });
      // Unclosed quotes closed, and the pattern so kept formatted; a NUL ends a pattern; 255 characters at most.
      f = new DateTimeFormatter("en-US");
      var long:String = "";
      while (long.length < 256) {
        long += "-";
      }
      for each (p in ["''''", "'''", "'a''", "'", "a'b'c", "yyyy'", "''yyyy''", "'''yyyy'''", "yyyy\u0000MM", long.substr(1), long, "yyyy " + long.substr(6)]) {
        f.setDateTimePattern(p);
        trace("quotes [" + p.substr(0, 12).split("\u0000").join("<nul>") + "]", p.length, f.lastOperationStatus, "[" + f.getDateTimePattern().substr(0, 12) + "]", f.getDateTimePattern().length,
          "[" + f.formatUTC(d).substr(0, 12) + "]");
      }
      // Windows' dates: from 1601, a year past 65535 wrapping; a time alone formats any date.
      for each (var year:Number in [1, 1600, 1601, 30827, 30828, 65535, 65536, 70000, 275760, -1]) {
        var day:Date = new Date(Date.UTC(year, 8, 13, 14, 5));
        f.setDateTimePattern("yyyy-MM-dd EEEE");
        var dated:String = "[" + f.formatUTC(day) + "] " + f.lastOperationStatus;
        f.setDateTimePattern("HH:mm 'x' a");
        trace("year", year, dated, "[" + f.formatUTC(day) + "]", f.lastOperationStatus);
      }
      // Russian's spaces are no-break ones in ICU, narrow ones in Windows: left out.
      for each (id in ["es-ES", "pt-BR", "fr-CA", "th-TH", "he-IL", "ko-KR"]) {
        f = new DateTimeFormatter(id);
        trace(id, "[" + f.getDateTimePattern() + "]");
      }
      for each (id in ["en-AU", "zh-CN", "ja-JP", "fr-FR", "fi-FI", "sv-SE", "he-IL", "hi-IN"]) {
        trace(id, new DateTimeFormatter(id).getWeekdayNames(DateTimeNameStyle.SHORT_ABBREVIATION).join("|"));
      }
      // Windows' last date is 14 September 30828; an invalid date is midnight of 1970 to a pattern
      // without the date in UTC, refused otherwise.
      f = new DateTimeFormatter("en-US");
      f.setDateTimePattern("yyyy-MM-dd HH:mm");
      for each (var last:Number in [Date.UTC(30828, 8, 14, 23, 59), Date.UTC(30828, 8, 15), Date.UTC(65536 + 30828, 8, 14), Date.UTC(65536 + 30828, 8, 15)]) {
        trace("last", "[" + f.formatUTC(new Date(last)) + "]", f.lastOperationStatus);
      }
      for each (p in ["HH:mm", "'x'", "''", "yyyy", "D", "QQQ", "w", "F", "z", "S"]) {
        f.setDateTimePattern(p);
        var at:Date = new Date(Date.UTC(1000, 0, 1));
        trace("invalid", p, "[" + f.formatUTC(new Date(NaN)) + "]", f.lastOperationStatus, "[" + f.formatUTC(at) + "]", f.lastOperationStatus);
      }
      // Closing a quote past 255 characters keeps no pattern; the limit counts past a NUL.
      var quoted:String = "'";
      while (quoted.length < 255) {
        quoted += "a";
      }
      f.setDateTimePattern(quoted);
      trace("overflow", f.lastOperationStatus, f.getDateTimePattern().length);
      f.setDateTimePattern("yyyy\u0000" + long);
      trace("limit past nul", f.lastOperationStatus, f.getDateTimePattern().length);
      trace("available", DateTimeFormatter.getAvailableLocaleIDNames().length > 0);
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
