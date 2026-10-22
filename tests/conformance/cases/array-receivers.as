// Array's natives on any receiver, as avmplus' generic functions: the
// length as getLengthProperty reads it (an Array's own, else its length
// property, whose getter an Array subclass may override), each element as
// getUintProperty, and nothing done for what is not an object.
import flash.utils.Proxy;
import flash.utils.flash_proxy;
dynamic class LenArr extends Array {
  public function LenArr(...rest) {
    for (var i:int = 0; i < rest.length; i++) {
      AS3::push(rest[i]);
    }
  }
  override public function get length():uint { return 5; }
}
class Holder {
  public function same(v:*, i:int, a:*):* { return this is Holder; }
}
function t(label:String, f:Function):void {
  try { trace(label, f()); } catch (e:Error) { trace(label, "error", e.errorID); }
}
var log:Array;
function rec(v:*, i:int, a:*):Boolean { log.push(i + "=" + v); return true; }
function id(v:*, i:int, a:*):* { return v; }
function yes(v:*, i:int, a:*):Boolean { return true; }
var P:Object = Array.prototype;

var l:LenArr = new LenArr(1, 2, 3);
t("len own", function():* { return l[0] + " " + l.hasOwnProperty("2") + " " + l.hasOwnProperty("3"); });
t("len forEach", function():* { log = []; l.forEach(rec); return log; });
t("len every some", function():* { return l.every(function(v:*, i:int, a:*):Boolean { return v !== undefined; }) + " " + l.some(function(v:*, i:int, a:*):Boolean { return v === undefined; }); });
t("len map filter", function():* { return l.map(id).length + " " + l.filter(yes).length; });
t("len indexOf", function():* { return l.indexOf(undefined) + " " + l.lastIndexOf(undefined) + " " + l.indexOf(3); });
t("len slice concat", function():* { return l.slice().length + " " + l.concat().length + " " + [0].concat(l).length; });
t("len join", function():* { return l.join("|"); });
t("len splice", function():* { var r:LenArr = new LenArr(1, 2, 3); return r.splice(1).length; });
t("len sort", function():* { var r:LenArr = new LenArr(3, 1, 2); return r.sort() + " " + r.hasOwnProperty("0") + r.hasOwnProperty("3"); });
t("len sort RIA", function():* { return new LenArr(3, 1, 2).sort(Array.RETURNINDEXEDARRAY); });
t("len sortOn", function():* { var r:LenArr = new LenArr({n: 2}, {n: 1}); r.sortOn("n", Array.NUMERIC); return r[0].n + "" + r[1].n; });
t("len to Vector", function():* { return Vector.<Number>(l); });

var o:Object = {length: 3, 0: "a", 2: "c"};
t("generic forEach", function():* { log = []; P.forEach.call(o, rec); return log; });
t("generic map", function():* { return P.map.call(o, id); });
t("generic filter", function():* { return P.filter.call(o, yes); });
t("generic every some", function():* { return P.every.call(o, function(v:*, i:int, a:*):* { return v !== undefined; }) + " " + P.some.call(o, function(v:*, i:int, a:*):* { return v === "c"; }); });
t("generic join", function():* { return P.join.call(o, "-"); });
t("generic indexOf", function():* { return P.indexOf.call(o, "c") + " " + P.lastIndexOf.call(o, "a") + " " + P.indexOf.call(o, undefined); });
t("generic concat", function():* { return P.concat.call(o, [1]).length; });
t("generic sort", function():* { var s:Object = {length: 4, 0: "d", 1: "b", 3: "a"}; var r:* = P.sort.call(s); return (r === s) + " " + s[0] + s[1] + s[2] + s[3] + " " + s.hasOwnProperty("2") + s.hasOwnProperty("3") + " " + s.length; });
t("generic sort numeric", function():* { var s:Object = {length: 3, 0: 3, 1: 10, 2: 2}; P.sort.call(s, Array.NUMERIC | Array.DESCENDING); return s[0] + "," + s[1] + "," + s[2]; });
t("generic sort compare", function():* { var s:Object = {length: 3, 0: 3, 1: 10, 2: 2}; P.sort.call(s, function(x:*, y:*):Number { return x - y; }); return s[0] + "," + s[1] + "," + s[2]; });
t("generic sort RIA", function():* { var s:Object = {length: 3, 0: "c", 1: "a", 2: "b"}; return P.sort.call(s, Array.RETURNINDEXEDARRAY) + " " + s[0]; });
t("generic sort UNIQUE", function():* { return P.sort.call({length: 2, 0: 1, 1: 1}, Array.UNIQUESORT); });
t("generic sortOn", function():* { var s:Object = {length: 3, 0: {n: 3}, 1: {n: 1}, 2: {n: 2}}; P.sortOn.call(s, "n"); return s[0].n + "" + s[1].n + s[2].n; });
t("generic sortOn fields", function():* { var s:Object = {length: 2, 0: {n: 1, m: 2}, 1: {n: 1, m: 1}}; P.sortOn.call(s, ["n", "m"]); return s[0].m + "" + s[1].m; });
t("generic length string", function():* { log = []; P.forEach.call({length: "2", 0: 1, 1: 2, 2: 3}, rec); return log; });
t("generic length getter", function():* { var calls:int = 0; var s:Object = {0: "x"}; s.length = 1; log = []; P.map.call(s, function(v:*, i:int, a:*):* { a.length = 3; return v; }); return s.length; });
t("generic grows during walk", function():* { var s:Object = {length: 2, 0: 1, 1: 2}; log = []; P.forEach.call(s, function(v:*, i:int, a:*):void { log.push(v); a.length = 5; a[2] = 9; }); return log; });
t("generic prototype element", function():* { Object.prototype[1] = "p"; var r:* = P.map.call({length: 2, 0: "o"}, id); delete Object.prototype[1]; return r; });
t("primitives", function():* { log = []; P.forEach.call("ab", rec); return log.length + " " + P.map.call("ab", id).length + " " + P.filter.call(5, yes).length + " " + P.sort.call("ab") + " " + P.every.call(null, rec) + " " + P.some.call(true, rec); });
t("vector receiver", function():* { log = []; P.forEach.call(new <int>[4, 5], rec); var v:Vector.<int> = new <int>[3, 1, 2]; P.sort.call(v); return log + " " + v + " " + P.map.call(new <String>["x", "y"], function(v:*, i:int, a:*):* { return v + i; }); });

var h:Holder = new Holder();
var other:Object = {};
t("closure map", function():* { return [1].map(h.same, other); });
t("closure generic map", function():* { return P.map.call({length: 1, 0: 1}, h.same, other); });
t("closure filter", function():* { return [1].filter(h.same, other); });
t("closure forEach", function():* { return [1].forEach(h.same, other); });
t("closure every", function():* { return [1].every(h.same, other); });
t("closure some", function():* { return [1].some(h.same, other); });
t("closure null receiver", function():* { return [1].filter(h.same, null); });
t("closure vector map", function():* { return new <int>[1].map(h.same, other); });
t("closure vector filter", function():* { return new <int>[1].filter(h.same, other).length; });
t("closure vector forEach", function():* { return new <int>[1].forEach(h.same, other); });
t("closure vector every", function():* { return new <int>[1].every(h.same, other); });

// A Namespace is no object to avmplus: nothing to walk, and no Vector's source.
var ns:Namespace = new Namespace("p", "u");
t("namespace receiver", function():* { log = []; P.forEach.call(ns, rec); return log.length + " " + P.map.call(ns, id).length + " " + P.sort.call(ns) + " " + P.indexOf.call(ns, 1) + " " + P.slice.call(ns) + " " + P.pop.call(ns); });
t("namespace to Vector", function():* { return Vector.<int>(ns); });
t("namespace comparator", function():* { return [3, 1].sort(ns); });

// splice takes its range within the length getLengthProperty reads, and
// splices the storage where that holds the range; unshift returns that length.
dynamic class Shorter extends Array {
  public function Shorter() { AS3::push(1, 2, 3, 4); }
  override public function get length():uint { return 2; }
}
function all(s:Array):String {
  var o:Array = [];
  for (var i:int = 0; i < 6; i++) {
    o.push(s[i]);
  }
  return o.join(",");
}
t("shorter splice insert", function():* { var s:Shorter = new Shorter(); var r:* = s.splice(0, 1, 7, 8); return r + " / " + all(s); });
t("shorter splice rest", function():* { var s:Shorter = new Shorter(); var r:* = s.splice(1); return r + " / " + all(s); });
t("shorter splice past", function():* { var s:Shorter = new Shorter(); var r:* = s.splice(5, 1, 9); return r + " / " + all(s); });
t("shorter unshift", function():* { var s:Shorter = new Shorter(); return s.unshift(5) + " / " + all(s); });
t("longer splice", function():* { var s:LenArr = new LenArr(1, 2, 3); var r:* = s.splice(2, 2, "x"); return r + " / " + all(s); });

// What sort and sortOn find missing they ask about as hasUintProperty
// does: a Proxy through its hasProperty.
dynamic class Logged extends Proxy {
  public var log:Array = [];
  public var has:Boolean;
  public function Logged(has:Boolean) { this.has = has; }
  override flash_proxy function getProperty(n:*):* {
    log.push("get " + n);
    return String(n) == "length" ? 3 : String(n) == "1" ? undefined : "e" + n;
  }
  override flash_proxy function setProperty(n:*, v:*):void { log.push("set " + n + "=" + v); }
  override flash_proxy function hasProperty(n:*):Boolean { log.push("has " + n); return has; }
  override flash_proxy function deleteProperty(n:*):Boolean { log.push("del " + n); return true; }
}
t("proxy sort", function():* { var p:Logged = new Logged(true); P.sort.call(p); return p.log; });
t("proxy sort missing", function():* { var p:Logged = new Logged(false); P.sort.call(p); return p.log; });
t("proxy sortOn", function():* { var p:Logged = new Logged(true); P.sortOn.call(p, "x"); return p.log; });
t("proxy sortOn missing", function():* { var p:Logged = new Logged(false); P.sortOn.call(p, "x"); return p.log; });
