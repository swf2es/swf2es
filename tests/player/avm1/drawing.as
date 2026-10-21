// MovieClip drawing, including invisible paths and version-dependent bounds.
var names = ["lineStyle", "moveTo", "lineTo", "curveTo", "beginFill", "endFill", "clear"];
for (var i = 0; i < names.length; i++) {
  trace(names[i] + " " + typeof MovieClip.prototype[names[i]]);
}

var d = createEmptyMovieClip("d", 1);
function box(label) {
  var b = d.getBounds(d);
  trace(label + " " + b.xMin + " " + b.yMin + " " + b.xMax + " " + b.yMax);
  d.clear();
}

if (typeof d.lineStyle == "function") {
  var values = [-1.234, 1.234, 0.025, NaN, Infinity, null, undefined, "4.25"];
  for (i = 0; i < values.length; i++) {
    d.lineStyle(0, 0);
    d.moveTo(values[i], 10);
    d.lineTo(40, 40);
    box("move " + i);
  }

  values = [NaN, undefined, null, -1, 0, 1, 1.234, 255, 256, Infinity,
    0.99, 1.99, 2.99, 255.99, -Infinity, "3.5", {}, false, true];
  for (i = 0; i < values.length; i++) {
    d.lineStyle(values[i], 0);
    d.moveTo(10, 10);
    d.lineTo(10, 20);
    box("width " + i);
  }

  d.lineStyle(2, 0); d.moveTo(10, 10); d.moveTo(15); d.lineTo(30, 30);
  box("move missing");
  d.lineStyle(2, 0); d.moveTo(10, 10); d.lineTo(15); d.lineTo(30, 30);
  box("line missing");
  d.lineStyle(2, 0); d.moveTo(10, 10); d.curveTo(15, 15, 20); d.lineTo(30, 30);
  box("curve missing");
  d.beginFill(0xff0000); d.moveTo(10, 10); d.lineTo(30, 10); d.lineTo(30, 30); d.endFill();
  box("fill");
  d.beginFill(); d.moveTo(10, 10); d.lineTo(30, 10); d.lineTo(30, 30); d.endFill();
  box("fill missing");
  d.beginFill(0xff0000); d.moveTo(10, 10); d.lineTo(30, 10); d.beginFill(); d.lineTo(30, 30); d.endFill();
  box("fill stopped");
  d.lineStyle(2, 0); d.moveTo(10, 10); d.lineTo(30, 30); d.clear(); d.lineTo(50, 50);
  box("clear style");
  d.moveTo(10, 20);
  box("move only");
  d.lineTo(10, 20);
  box("line invisible");
  d.moveTo(10, 10); d.curveTo(100, 100, 30, 10);
  box("curve invisible");
  d.lineStyle(2); d.moveTo(10, 10); d.curveTo(100, 100, 30, 10);
  box("curve stroke");
  d.beginFill(0); d.moveTo(10, 10); d.curveTo(100, 100, 30, 10); d.endFill();
  box("curve fill");
  d.moveTo(-10, -10); d.curveTo(-100, -100, -30, -10);
  box("curve negative");
  d.moveTo(10.05, 10.05); d.curveTo(100.05, 100.05, 30.05, 10.05);
  box("curve twips");

  var n = {valueOf: function() { trace("number"); return 4; }};
  var str = {toString: function() { trace("string"); return "miter"; }};
  d.lineStyle(n, n, n, n, str, str, str, n);
  d.clear();

  if (typeof flash.display.BitmapData == "function") {
    values = [-10, 0, 1, 2, 10, 20, 40, 50, 80, 99, 100, 255, 50.5, NaN, null, undefined];
    for (i = 0; i < values.length; i++) {
      d.lineStyle(4, 0xabcdef, values[i]); d.moveTo(10, 5); d.lineTo(10, 25);
      var bitmap = new flash.display.BitmapData(40, 40, true, 0);
      bitmap.draw(d);
      trace("alpha " + i + " " + (bitmap.getPixel32(10, 15) >>> 24));
      bitmap.dispose();
      d.clear();
      d.beginFill(0xffffff, values[i]); d.moveTo(10, 10); d.lineTo(30, 10);
      d.lineTo(30, 30); d.lineTo(10, 30); d.endFill();
      bitmap = new flash.display.BitmapData(40, 40, true, 0);
      bitmap.draw(d);
      trace("fillalpha " + i + " " + bitmap.getPixel32(15, 15).toString(16));
      bitmap.dispose();
      d.clear();
    }

    d.beginFill(undefined); d.moveTo(10, 10); d.lineTo(30, 10);
    d.lineTo(30, 30); d.lineTo(10, 30); d.endFill();
    bitmap = new flash.display.BitmapData(40, 40, true, 0);
    bitmap.draw(d);
    trace("fillundefined " + bitmap.getPixel32(15, 15).toString(16));
    bitmap.dispose();
    d.clear();
  }
}
