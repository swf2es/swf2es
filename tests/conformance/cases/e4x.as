// E4X as the runtime sees it outside XML's own methods: the default XML
// namespace of the scope a method or class was made in, not its caller's,
// and the one a method sets given back after it, Namespace
// and QName enumerated, compared and used as names, and delete by an
// XMLList, a TypeError. Also some of XML's own: names found in the default
// namespace, children hiding XML's methods of their names, writes to lists
// back into their tree, XML's text, and an XML name as a trait's name.
package {
  public class Scoped {
    public function uri():String { return (<x/>).namespace().uri; }
  }
}
namespace zz = "urn:test";
class Named { zz var value:int = 42; }
class Holder { public static var C:Class = QName; public static var X:Class = XML; }
function indirect(c:*, value:String):* { return c(value); }
function aliased():* { return new Holder.C("x"); }
function aliasedXML():* { return new Holder.X("<a/>"); }

function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); }
}

var soap:Namespace = new Namespace("soap", "http://soap/");
default xml namespace = soap;

function setsItsOwn():String {
  var before:String = (<a/>).namespace().uri;
  default xml namespace = "http://inner/";
  return before + "|" + (<a/>).namespace().uri;
}

function setsNone():String {
  return (<a/>).namespace().uri;
}

probe("dxns in a method that sets it", setsItsOwn);
probe("dxns after it returns", setsNone);
probe("dxns of a class method", function():* {
  default xml namespace = "http://caller/";
  return "[" + new Scoped().uri() + "]";
});
probe("dxns of an indirect call and an aliased class", function():* {
  default xml namespace = "http://caller/";
  return [indirect(QName, "x").uri, indirect(XML, "<a/>").namespace().uri, aliased().uri,
    aliasedXML().namespace().uri, Holder.C("y").uri].join("|");
});
probe("dxns after a throw", function():* {
  try {
    (function():void { default xml namespace = "http://thrown/"; throw new Error("x"); })();
  } catch (e:Error) {}
  return (<b/>).namespace().uri;
});
default xml namespace = "";

probe("namespace for-in", function():* {
  var n:Namespace = new Namespace("p", "http://u/");
  var names:Array = [], values:Array = [];
  for (var k:String in n) names.push(k);
  for each (var v:* in n) values.push(v);
  return names.join(",") + " " + values.join(",");
});
probe("qname for-in", function():* {
  var q:QName = new QName("http://u/", "local");
  var names:Array = [], values:Array = [];
  for (var k:String in q) names.push(k);
  for each (var v:* in q) values.push(v);
  return names.join(",") + " " + values.join(",");
});
probe("namespace ==", function():* {
  return [new Namespace("a", "http://u/") == new Namespace("b", "http://u/"),
    new Namespace("http://u/") == new Namespace("http://v/")].join(",");
});
probe("qname ==", function():* {
  return [new QName("http://u/", "a") == new QName(new Namespace("p", "http://u/"), "a"),
    new QName("a") == new QName("b")].join(",");
});
probe("namespace prefix", function():* {
  return [new Namespace("p", "http://u/").prefix, new Namespace("http://u/").prefix,
    new Namespace().prefix, new Namespace("", "").prefix].join(",");
});
probe("prefix and no uri", function():* { return new Namespace("p", ""); });

var x:XML = <root xmlns:u="http://u/"><name>n</name><u:item id="1">one</u:item><u:item id="2">two</u:item></root>;
var u:Namespace = new Namespace("http://u/");
probe("child hides method", function():* { return x.name + " " + x.name(); });
probe("qname as name", function():* { return x[new QName(u, "item")].length(); });
probe("any namespace", function():* { return x.*::item.length() + " " + x.*::item.@id; });
probe("attribute by qname", function():* { return x.u::item.(@id == "2").toString(); });
probe("delete by list", function():* { delete x.u::item[x.u::item.(@id == "1")]; return x.u::item.length(); });
probe("delete filter", function():* { delete x.u::item.(@id == "1"); return "no error"; });
probe("write back", function():* {
  var y:XML = <a/>;
  y.b.c = "deep";
  y.b.c.@k = "v";
  return y.toXMLString();
});
probe("strings", function():* {
  var y:XML = <a>  text  </a>;
  return "[" + y + "][" + String(<a><b>1</b><b>2</b></a>.b) + "][" + (<a x="&quot;"/>).toXMLString() + "]";
});
probe("equality", function():* {
  var five:XML = <a>5</a>, one:XML = <a><b/></a>, two:XML = <a><b/></a>, text:XML = <a>x</a>;
  return [five == 5, one == two, one === two, text == "x", new XMLList() == undefined].join(",");
});
probe("plus", function():* { var a:XML = <a/>, b:XML = <b/>; return (a + b).length(); });
probe("xml name as a trait's name", function():* {
  var xml:XML = <p:value xmlns:p="urn:test"/>;
  return new Named()[xml.name()];
});
