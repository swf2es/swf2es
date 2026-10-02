// An Object can be a primitive or a Namespace: Object's own methods,
// called on one bound early, are its class prototype's.
function on(o:Object):String {
  return [o.AS3::hasOwnProperty("x"), o.AS3::propertyIsEnumerable("length"), o.AS3::isPrototypeOf(o)].join(" ");
}
trace(on(1), on(1.5), on("s"), on(true), on(new Namespace("u")));
var d:Object = {x: 1};
trace(on(d), on([1]), on(Object.prototype));
for (var i:int = 0; i < 3; i++) {
  trace((1).hasOwnProperty(""), ("s").hasOwnProperty("length"));
}
