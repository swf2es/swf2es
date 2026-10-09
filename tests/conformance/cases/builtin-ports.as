// What builtin's AS3 did that its natives must do too: coerce as its
// parameters' types say.
package {
  public dynamic class Named {}
}
import Named;

// No argument is undefined, a String null, the name "null".
var o:Named = new Named();
o["null"] = 1;
o["undefined"] = 2;
trace(o.hasOwnProperty(), o.propertyIsEnumerable());
trace(Object.prototype.hasOwnProperty.call(o), Object.prototype.propertyIsEnumerable.call(o));
