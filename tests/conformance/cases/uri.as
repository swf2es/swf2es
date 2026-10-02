// The URI functions, escape and unescape: what they write and read, their
// errors, their default argument, and the length of functions and of
// method closures, which is their declared parameters.
package {
  public class M {
    public function two(a:int, b:String = "x"):void {}
    public static function none():void {}
  }
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:URIError) { trace(name, "URIError", e.errorID, e.message); }
}
var hi:String = String.fromCharCode(0xd800), lo:String = String.fromCharCode(0xdc00);
probe("encodeURI", function():* { return encodeURI("http://a.b/c d?e=f&g#h é€" + String.fromCharCode(0xd83d, 0xde00)); });
probe("encodeURIComponent", function():* { return encodeURIComponent("a b/c?d=e&f#g;h,i+j@k"); });
probe("decodeURI", function():* { return decodeURI("%41%2F%3F%23%20%C3%A9"); });
probe("decodeURIComponent", function():* { return decodeURIComponent("%41%2F%3F%23%20%C3%A9"); });
probe("encode lone high", function():* { return encodeURI("a" + hi); });
probe("encode lone low", function():* { return encodeURIComponent(lo + "a"); });
probe("decode bad hex", function():* { return decodeURI("%zz"); });
probe("decode short", function():* { return decodeURIComponent("%4"); });
probe("decode bad utf8", function():* { return decodeURI("%C3%28"); });
probe("decode overlong", function():* { return decodeURIComponent("%C0%AF"); });
probe("escape", function():* { return escape("a b+c/d@e*f_g.h-i~j é€\u0001"); });
probe("unescape", function():* { return unescape("%41%u20AC%zz%u12%4"); });
probe("defaults", function():* { return [escape(), unescape(), encodeURI(), decodeURI(), encodeURIComponent(), decodeURIComponent()].join(","); });
probe("undefined and null", function():* { return [escape(undefined), escape(null), encodeURI(null), decodeURI(undefined)].join(","); });
probe("lengths", function():* { return [escape.length, unescape.length, encodeURI.length, decodeURIComponent.length, parseInt.length, parseFloat.length, isNaN.length, isFinite.length, trace.length].join(","); });
var m:M = new M();
probe("method lengths", function():* { return [m.two.length, M.none.length, function(a, b, c):void {}.length].join(","); });
// A surrogate's UTF-8 decodes as its code unit; what else is malformed still fails.
function units(s:String):String {
  var out:Array = [];
  for (var i:int = 0; i < s.length; i++) {
    out.push(s.charCodeAt(i).toString(16));
  }
  return out.join(",");
}
for each (var enc:String in ["%ED%B0%80%ED%A0%80", "a%ED%A0%80b%20c", "%ED%BF%BF%3B", "%E4%ED%B0%80", "%ED%B0", "%ED%C0%80"]) {
  var results:Array = [];
  for each (var dec:Function in [decodeURI, decodeURIComponent]) {
    try { results.push(units(dec(enc))); } catch (e:Error) { results.push(e); }
  }
  trace(enc, results.join(" | "));
}
