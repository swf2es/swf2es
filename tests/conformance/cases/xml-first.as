// XML as the first thing a program uses. The builtin script defining
// Object makes XML values as it runs, and XML's script needs Object, so the
// script defining Object runs first, as avmplus' Toplevel is made from it.
var x:* = <a b="1"><c/></a>;
trace(x.toXMLString());
trace(x.@b, x.c.length());
