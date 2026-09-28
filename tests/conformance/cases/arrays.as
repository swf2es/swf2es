// Arrays: construction, length, holes, and the methods.
var a:Array = [3, 1, 2];
trace(a.length, a, a.join("-"), a.toString(), a.indexOf(2), a.lastIndexOf(9));
a.push(4, 5);
trace(a.pop(), a.shift(), a.unshift(0), a);
trace(a.slice(1, 3), a.slice(-2), a.concat([9], 8, [[7]]), a.reverse());
var b:Array = [5, 1, 10, 2];
trace(b.sort(), b.sort(Array.NUMERIC), b.sort(function(x:int, y:int):int { return y - x; }));
var c:Array = ["b", "a", "C"];
trace(c.sort(), c.sort(Array.CASEINSENSITIVE), c.sort(Array.DESCENDING));
var d:Array = [1, 2, 3, 4, 5];
trace(d.splice(1, 2), d, d.splice(1, 0, "x", "y"), d);
var e:Array = new Array(3);
trace(e.length, e, e[0], new Array(1, 2), new Array("3"));
e[5] = "five";
trace(e.length, e);
e.length = 2;
trace(e.length, e);
trace([1, 2, 3].map(function(x:*, i:int, arr:Array):* { return x * 2; }));
trace([1, 2, 3, 4].filter(function(x:*, i:int, arr:Array):Boolean { return x % 2 == 0; }));
trace([1, 2, 3].every(function(x:*, i:int, arr:Array):Boolean { return x > 0; }), [1, 2].some(function(x:*, i:int, arr:Array):Boolean { return x > 1; }));
var total:int = 0;
var ones:Array = [1, 2, 3];
ones.forEach(function(x:*, i:int, arr:Array):void { total += x; });
trace(total, [[1, 2], [3]].length, [null, undefined, 1].join(","));
var people:Array = [{n: "b", a: 2}, {n: "a", a: 3}, {n: "c", a: 1}];
people.sortOn("n");
trace(people.map(function(p:*, i:int, arr:Array):* { return p.n; }));
people.sortOn("a", Array.NUMERIC | Array.DESCENDING);
trace(people.map(function(p:*, i:int, arr:Array):* { return p.n; }));
// A hole reads through to Array.prototype, in the callbacks and in sort.
var holes:Array = [];
holes[1] = 2;
Array.prototype[0] = 99;
trace("holes", holes.map(function(x:*, i:int, arr:Array):* { return x; }), holes.every(function(x:*, i:int, arr:Array):Boolean { return x > 0; }));
delete Array.prototype[0];
// A for-in started inside another over the same array leaves the outer one's names where they were.
var nested:Array = [10, 20, 30];
var nestedSeen:Array = [];
for (var nk:String in nested) {
    nestedSeen.push(nk);
    if (nk == "0") {
        delete nested[0];
        for (var nj:String in nested) {}
    }
}
trace("nested for-in", nestedSeen.join(","));
// And over an object, whose names are counted, in no order the case depends on.
var nestedObject:Object = {a: 1, b: 2, c: 3};
var nestedCount:int = 0;
for (var ok:String in nestedObject) {
    nestedCount++;
    for (var oj:String in nestedObject) {}
}
trace("nested object for-in", nestedCount);
