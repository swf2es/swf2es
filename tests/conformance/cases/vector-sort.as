package {
  var v:Vector.<int> = new Vector.<int>();
  v.push(3, 1, 2);
  v.sort(function (a:int, b:int):int { return a - b; });
  trace(v.join(","), typeof v, v is Vector.<int>, v.length);
}
