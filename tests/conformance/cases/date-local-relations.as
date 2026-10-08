// Local time by its relations to UTC, which hold in any zone, the
// oracle's UTC included: a local date's fields are the ones it was made
// of, its time is the UTC one less its offset, Date.parse of the same
// local string agrees, toString's GMT+hhmm is the offset, and a local
// setter keeps the time of day. Years past 2038 and before 1901 are where
// avmshell's 32-bit time_t ends.
function gmt(offset:Number):String {
  var east:int = Math.abs(offset);
  var hhmm:int = int(east / 60) * 100 + east % 60;
  var digits:String = "000" + hhmm;
  return "GMT" + (offset <= 0 ? "+" : "-") + digits.substr(digits.length - 4);
}

var months:Array = ["Jan", "Apr", "Jul", "Oct"];
for each (var y:int in [1900, 1901, 1969, 1970, 2026, 2037, 2038, 2039, 2050, 2100, 275760]) {
  var line:Array = [y];
  for (var m:int = 0; m < 12; m += 3) {
    var d:Date = new Date(y, m, 1, 12, 30);
    var fields:Boolean = d.fullYear == y && d.month == m && d.date == 1 && d.hours == 12 &&
      d.minutes == 30;
    var utc:Boolean = d.time == Date.UTC(y, m, 1, 12, 30) + d.timezoneOffset * 60000;
    var parsed:Boolean = Date.parse(months[m / 3] + " 1 " + y + " 12:30:00") == d.time;
    var zone:Boolean = d.toString().indexOf(" 12:30:00 " + gmt(d.timezoneOffset) + " " + y) > 0;
    var locale:Boolean = d.toLocaleString().indexOf(" 12:30:00 PM") > 0;
    var hours:Boolean = (d.hours * 60 + d.minutes - d.hoursUTC * 60 - d.minutesUTC -
      -d.timezoneOffset) % 1440 == 0;
    var e:Date = new Date(d.time);
    e.date = 15;
    var setter:Boolean = e.hours == 12 && e.minutes == 30 && e.date == 15;
    e.fullYear = 2026;
    setter = setter && e.hours == 12 && e.fullYear == 2026;
    line.push(fields && utc && parsed && zone && locale && hours && setter);
  }
  trace(line.join(" "));
}

// A UTC time read back through local fields gives the same instant. Not
// at the last second of a 32-bit time_t in a zone in daylight saving
// then, such as Sydney: the local time's UTC one is past it, so standard.
for each (var t:Number in [-2208945600000, -2147483649000, -2147483648000, 0, 1782907200000,
    2147483648000, 2540289600000, 8639993649600000]) {
  var a:Date = new Date(t);
  var b:Date = new Date(a.fullYear, a.month, a.date, a.hours, a.minutes, a.seconds,
    a.milliseconds);
  trace(t, b.time == t, a.timezoneOffset == b.timezoneOffset);
}
