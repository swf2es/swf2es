// Integer wrapping and coercions that JavaScript does differently by default.
package {
  var i:int = 2147483647;
  i++;
  var u:uint = -1;
  trace("int wrap", i, "uint", u);
  trace("int()", int("12.9"), int(-3.7), int(NaN), int(4294967297));
  trace("uint()", uint(-2), uint(3.9));
  trace("sum", 0.1 + 0.2);
}
