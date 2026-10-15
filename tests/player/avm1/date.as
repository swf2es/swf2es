// Date in AVM1, by version (docs/avm1.md, "Date"): what holds in any time
// zone, as the tests run in whichever the host has: UTC's fields and
// setters, Date.UTC, the constructor's forms by their times, clipping,
// setMonth's day from SWF 7, and local time's relation to UTC. Local
// times themselves, in a zone with daylight saving, are the unit tests'.
function utc(d) { return d.getUTCFullYear() + "-" + d.getUTCMonth() + "-" + d.getUTCDate() + " " + d.getUTCDay() + " " + d.getUTCHours() + ":" + d.getUTCMinutes() + ":" + d.getUTCSeconds() + "." + d.getUTCMilliseconds() + " y" + d.getUTCYear(); }
function consistent(d) { return d.getTime() - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()) == d.getTimezoneOffset() * 60000; }
var d = new Date(Date.UTC(2026, 9, 15, 12, 34, 56, 789));
trace("utc " + utc(d) + " time " + d.getTime() + " valueOf " + d.valueOf() + " " + (d - 0));
trace("consistent " + consistent(d) + " " + consistent(new Date(0)) + " " + consistent(new Date(Date.UTC(1900, 6, 1))) + " " + consistent(new Date(Date.UTC(2050, 0, 1))));
trace("local fields " + typeof d.getHours() + " " + (d.getFullYear() - d.getYear()) + " " + (d.getDay() >= 0 && d.getDay() < 7));
var forms = [new Date(0), new Date(1e12), new Date(-1e12), new Date(1e17), new Date(0/0), new Date("2026"), new Date(2026), new Date(undefined).getTime() > 1e12, new Date(null), new Date(2026, undefined), new Date(true), new Date(8.64e15 + 1)];
for (var i = 0; i < forms.length; i++) { var f = forms[i]; trace("form " + i + " " + (typeof f == "object" ? f.getTime() + " " + (isNaN(f.getTime()) ? "invalid" : utc(f)) : f)); }
trace("fields " + (new Date(2026, 13, 40).getTime() - new Date(2027, 2, 12).getTime()) + " " + (new Date(2026, -1).getTime() - new Date(2025, 11).getTime()) + " " + (new Date(2026.7, 1.9, 2.5).getTime() - new Date(2026, 1, 2).getTime()) + " " + (new Date(99, 0).getFullYear()) + " " + (new Date(100, 0).getFullYear()));
trace("UTC " + Date.UTC(2026, 9, 15) + " " + Date.UTC(99, 0) + " " + Date.UTC(2026) + " " + Date.UTC() + " " + Date.UTC(2026, 0, 1, 25, 61, 61, 1001) + " " + Date.UTC(0, 0) + " " + Date.UTC(-1, 0) + " " + Date.UTC(2026, 0/0) + " " + Date.UTC(1e10, 0));
var s = new Date(Date.UTC(2026, 0, 31, 10, 0, 0));
trace("setUTCMonth " + s.setUTCMonth(1) + " " + utc(s));
s = new Date(Date.UTC(2024, 0, 31, 10)); trace("leap " + s.setUTCMonth(1) + " " + s.getUTCDate());
s = new Date(Date.UTC(2026, 2, 31, 10)); trace("april " + s.setUTCMonth(3) + " " + s.getUTCDate() + " " + s.setUTCMonth(3, 31) + " " + utc(s));
s = new Date(Date.UTC(2026, 0, 31, 10)); trace("13 " + s.setUTCMonth(13) + " " + utc(s));
s = new Date(Date.UTC(2026, 0, 31, 10)); trace("fullYear " + s.setUTCFullYear(2026, 1) + " " + utc(s));
s = new Date(Date.UTC(2024, 1, 29, 10)); trace("feb 29 " + s.setUTCFullYear(2025) + " " + utc(s));
s = new Date(Date.UTC(2026, 0, 31, 10)); trace("-1 " + s.setUTCMonth(-1) + " " + utc(s) + " 1.5 " + s.setUTCMonth(1.5) + " " + utc(s));
s = new Date(Date.UTC(2026, 0, 31, 10));
trace("setUTCFullYear " + s.setUTCFullYear(2024, 1, 29) + " " + s.setUTCFullYear(2025) + " " + s.getUTCDate());
trace("setHours " + s.setUTCHours(25) + " " + s.setUTCMinutes(90, 90, 1500) + " " + s.setUTCSeconds(-1) + " " + s.setUTCMilliseconds(1e3) + " " + s.setUTCDate(0) + " " + utc(s));
trace("set NaN " + s.setUTCHours(0/0) + " " + s.getUTCHours() + " " + s.setTime(0/0) + " " + s + " " + s.getFullYear() + " " + s.getTimezoneOffset() + " " + s.setUTCFullYear(2026) + " " + s.setTime(1e20) + " " + s.setTime(8.64e15) + " " + s.setTime(8.64e15 + 1));
trace("set none " + s.setTime() + " " + new Date(0).setUTCHours() + " " + new Date(0).setUTCDate() + " " + new Date(0).setUTCMonth());
trace("range " + new Date(-8.64e15).getUTCFullYear() + " " + utc(new Date(Date.UTC(-5, 0, 1))) + " " + utc(new Date(-62198755200000)));
trace("Date() " + typeof Date() + " " + (Date().length > 20) + " " + typeof Date);
var o = {}; o.g = Date.prototype.getTime; o.t = Date.prototype.toString; o.u = Date.prototype.getUTCFullYear;
trace("generic " + o.g() + " " + o.t() + " " + o.u());
trace("compare " + (new Date(5) < new Date(6)) + " " + (new Date(5) == new Date(5)) + " " + (new Date(5) == 5) + " " + (new Date(5) + 0 == new Date(5).toString() + "0"));
trace("invalid " + new Date(0/0) + " " + (new Date(0/0) + 1));
trace("ASnative " + ASnative(103, 16).call(new Date(7)) + " " + ASnative(103, 257)(2000, 0) + " " + typeof ASnative(103, 999));
var dateProto = Date.prototype;
Date.prototype = {};
var DateSub = function () {};
__op("Extends", Date, DateSub);
trace("prototype " + (Date.prototype == dateProto) + " " + (new Date(0) instanceof Date));
