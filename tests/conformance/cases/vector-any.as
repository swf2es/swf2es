// Vector.<*> holds Objects, as avmplus' ObjectVectorObject: an undefined
// stored by any path is null, while an empty Vector's pop is undefined.
function show(label:String, v:Vector.<*>):void {
  var kinds:Array = [];
  for (var i:int = 0; i < v.length; i++) {
    kinds.push(v[i] === undefined ? "u" : v[i] === null ? "n" : String(v[i]));
  }
  trace(label, v.length, kinds.join(","), v.join("|"));
}
show("conversion", Vector.<*>([undefined, null, 1]));
show("literal", new <*>[undefined, null]);
var set:Vector.<*> = new Vector.<*>(2);
set[0] = undefined;
var any:* = set;
any[1] = undefined;
show("set", set);
show("from Vector.<Object>", Vector.<*>(new <Object>[null, undefined]));
var holes:Array = [];
holes.length = 2;
show("holes", Vector.<*>(holes));
show("map", new <*>[1, 2].map(function(x:*, i:int, s:*):* { return undefined; }));
var grown:Vector.<*> = new <*>[];
grown.push(undefined, 2);
grown.unshift(undefined);
grown.splice(0, 0, undefined);
grown.length = 7;
show("grown", grown);
show("concat", new <*>[undefined].concat(new <*>[undefined]));
show("filter", Vector.<*>([undefined, 1]).filter(function(x:*, i:int, s:*):Boolean { return true; }));
var empty:Vector.<*> = new <*>[];
trace(empty.pop() === undefined, empty.shift() === undefined);
var objects:Vector.<Object> = new <Object>[undefined];
objects.push(undefined);
trace(objects[0] === null, objects[1] === null, objects.indexOf(null), objects.indexOf(undefined));
