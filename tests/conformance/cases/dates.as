// Dates: Date.parse and new Date(string) as avmplus' own parser reads,
// the formats toString writes, a few others, and what it refuses; the
// fields, UTC and local (the oracle runs in UTC), and the constructor.
function show(s:String):void {
  var t:Number = Date.parse(s);
  trace("[" + s + "]", t, isNaN(t) ? "" : new Date(t).toUTCString());
}
show("Thu Jan 1 00:00:00 GMT+0000 1970");
show("Mon Jan 1 00:00:00 GMT-0800 1900");
show("Mon Jan 1 00:00:00 UTC-0800 1900");
show("Sun Sep 12 11:11:11 GMT-0900 2004");
show("Sun Sep 12 11:11:11 GMT-9 2004");
show("Sun Sep 12 11:11:11 GMT+0530 2004");
show("1/1/1999 13:30 PM");
show("1/1/1999 1:30 PM");
show("12/31/1999 12:00 AM");
show("12/31/99");
show("2/29/2000 23:59:59");
show("Jan 5 2010");
show("5 Jan 2010 UTC");
show("Feb 30 2010");
show("2010");
show("Sept 12 2004");
show("sep 12 2004");
show("2004-09-12");
show("2004/09/12");
show("Sep 12 2004 13:00 PM");
show("Sep 12 2004 1:02:03");
show("Sep 12 2004 1:02:03:04");
show("");
show("garbage");
show("Sep 12 2004 x");
show("Sep 12, 2004, 10:20");
show(new Date(86400000).toString());
show(new Date(123456789000).toString());
show(new Date(123456789000).toUTCString());
show(new Date(0).toDateString());
show(new Date(0).toLocaleString());
trace(new Date("Jan 2 1970 UTC").time, new Date("nonsense").time);
var v:Object = { valueOf: function():* { return "Jan 2 1970"; } };
trace(new Date(v).time);
var d:Date = new Date(2004, 8, 12, 11, 11, 11, 500);
trace(d.time, d.fullYear, d.month, d.date, d.day, d.hours, d.minutes, d.seconds, d.milliseconds);
trace(d.toString(), "|", d.toUTCString(), "|", d.toLocaleTimeString());
trace(new Date(99, 0).fullYear, new Date(100, 0).fullYear, Date.UTC(2004, 8, 12));
// The constructor clips a parsed string's time; Date.parse does not.
trace(new Date("Sep 13 275760 00:00:01 UTC").time, Date.parse("Sep 13 275760 00:00:01 UTC"));
