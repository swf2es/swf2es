// What avmplus' interpreter, which runs script and class initializers,
// does otherwise than its JIT, which runs everything else: an int key of
// an object is an element whatever namespaces its name has, an attribute's
// too, where the JIT asks for a public one and throws without it (1081).
namespace elsewhere = "urn:elsewhere";

function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); }
}

var top:Array = [1, 2, 3];
var hash:Object = {};
var vector:Vector.<int> = new Vector.<int>();
vector.push(7);
try { trace("script get", top.elsewhere::[0]); } catch (e:Error) { trace("script get", e.errorID); }
try { top.elsewhere::[1] = 20; trace("script set", top); } catch (e:Error) { trace("script set", e.errorID); }
try { trace("script past end", top.elsewhere::[9]); } catch (e:Error) { trace("script past end", e.errorID); }
try { trace("script negative", top.elsewhere::[-1]); } catch (e:Error) { trace("script negative", e.errorID); }
try { trace("script fraction", top.elsewhere::[1.5]); } catch (e:Error) { trace("script fraction", e.errorID); }
try { trace("script string", top.elsewhere::["0"]); } catch (e:Error) { trace("script string", e.errorID); }
var untyped:* = 2;
try { trace("script untyped", top.elsewhere::[untyped]); } catch (e:Error) { trace("script untyped", e.errorID); }
try { hash.elsewhere::[3] = "three"; trace("script object", hash[3], hash.elsewhere::[3]); } catch (e:Error) { trace("script object", e.errorID); }
try { trace("script vector", vector.elsewhere::[0]); } catch (e:Error) { trace("script vector", e.errorID); }
try { vector.elsewhere::[1] = 8; trace("script vector set", vector); } catch (e:Error) { trace("script vector set", e.errorID); }
try { trace("script string receiver", "abc".elsewhere::[0]); } catch (e:Error) { trace("script string receiver", e.errorID); }
var xml:XML = <a b="1"><c/><d/></a>;
try { trace("script attribute", xml.@[0], xml.@[1]); } catch (e:Error) { trace("script attribute", e.errorID); }

class Statics {
  static var list:Array = [4, 5];
  {
    try { trace("class get", list.elsewhere::[1]); } catch (e:Error) { trace("class get", e.errorID); }
    try { list.elsewhere::[2] = 6; trace("class set", list); } catch (e:Error) { trace("class set", e.errorID); }
  }

  static function inMethod():void {
    try { trace("method get", list.elsewhere::[0]); } catch (e:Error) { trace("method get", e.errorID); }
    try { list.elsewhere::[0] = 9; trace("method set", list); } catch (e:Error) { trace("method set", e.errorID); }
  }
}

Statics.inMethod();
probe("function get", function ():* { return top.elsewhere::[0]; });
probe("function set", function ():* { top.elsewhere::[0] = 1; return top; });
probe("function attribute", function ():* { return xml.@[0] + "," + xml.@[1]; });
