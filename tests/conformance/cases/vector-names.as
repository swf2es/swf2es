import avmplus.*;
import avmplus.Domain;
class Foo {}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e); }
}
probe("int qname", function():* { return getQualifiedClassName(new Vector.<int>()); });
probe("uint qname", function():* { return getQualifiedClassName(Vector.<uint>); });
probe("Number qname", function():* { return getQualifiedClassName(Vector.<Number>); });
probe("Object qname", function():* { return getQualifiedClassName(Vector.<Object>); });
probe("* qname", function():* { return getQualifiedClassName(Vector.<*>); });
probe("Foo qname", function():* { return getQualifiedClassName(Vector.<Foo>); });
probe("String qname", function():* { return getQualifiedClassName(Vector.<String>); });
probe("nested qname", function():* { return getQualifiedClassName(Vector.<Vector.<int>>); });
probe("Vector qname", function():* { return getQualifiedClassName(Vector); });
probe("int string", function():* { return String(Vector.<int>); });
probe("* string", function():* { return String(Vector.<*>); });
probe("Foo string", function():* { return String(Vector.<Foo>); });
probe("nested string", function():* { return String(Vector.<Vector.<int>>); });
probe("Vector string", function():* { return String(Vector); });
probe("int super", function():* { return getQualifiedSuperclassName(Vector.<int>); });
probe("Foo super", function():* { return getQualifiedSuperclassName(Vector.<Foo>); });
probe("describe int", function():* { return describeType(Vector.<int>, FLASH10_FLAGS).@name; });
probe("describe Foo", function():* { return describeType(new Vector.<Foo>(), FLASH10_FLAGS).@name; });
probe("describe Foo base", function():* { return describeType(new Vector.<Foo>(), FLASH10_FLAGS).extendsClass.@type; });
probe("getClass int", function():* { return Domain.currentDomain.getClass("__AS3__.vec::Vector.<int>"); });
probe("getClass Foo", function():* { return Domain.currentDomain.getClass("__AS3__.vec::Vector.<Foo>"); });
probe("getClass Vector$int", function():* { return Domain.currentDomain.getClass("__AS3__.vec::Vector$int"); });
probe("error", function():* { var v:Vector.<int> = Vector.<int>(new Vector.<Foo>()); return v; });
probe("coerce error", function():* { var o:* = new Vector.<Foo>(); var v:Vector.<int> = o; return v; });
