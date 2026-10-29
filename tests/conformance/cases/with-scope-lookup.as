// What a with scope has, as findproperty searches it: its traits, then
// what its class says it has (an XML's children and attributes), then its
// prototype chain. An E4X filter is a with scope over each item, so a
// filter that calls an XML method finds it on XML.prototype.
var x:XML = <e><technique><constant/></technique><technique><phong/><name>n</name></technique></e>;
trace(x.technique.*.(localName() == "phong").length());
trace(x.technique.*.(name() == "constant").length());
trace(x.technique.(childIndex() == 1).length());
trace(x.technique.(hasOwnProperty("name")).length());
trace(x.technique.*.(localName() == "phong" || localName() == "blinn")[0].toXMLString());

var c:XML = x.technique[0].constant[0];
with (c) {
  trace(localName(), nodeKind(), toXMLString());
}

// A child named like a method: the child, by the XML's children, is not
// what a call finds when traits or the prototype have it first.
var t:XML = x.technique[1];
with (t) {
  trace(typeof name, name());
}

dynamic class Holder {
  public var field:String = "field";
}
Holder.prototype.shared = function():String { return "shared"; };
var h:Holder = new Holder();
h.own = "own";
with (h) {
  trace(field, own, shared());
}

with ("text") {
  trace(length, charAt(1), toUpperCase());
}

var o:Object = { a: 1 };
with (o) {
  trace(a, hasOwnProperty("a"), toString());
}

try {
  with (c) {
    trace(missing());
  }
} catch (e:Error) {
  trace(e.errorID);
}
