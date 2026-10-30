// BitmapData.draw of a clip with the erase and alpha blends, as AS3's
// (draw-erase): by name and by number, a half-transparent fill, and a
// BitmapData source, which they leave alone; normal beside
// them. Each is drawn over green, its middle row traced; then what draw
// returns.

var square = createEmptyMovieClip("square", 1);
square.beginFill(0x000000, 100);
square.moveTo(3, 3);
square.lineTo(9, 3);
square.lineTo(9, 9);
square.lineTo(3, 9);
square.endFill();
square._x = 100;

var half = createEmptyMovieClip("half", 2);
half.beginFill(0xff0000, 50);
half.moveTo(3, 3);
half.lineTo(9, 3);
half.lineTo(9, 9);
half.lineTo(3, 9);
half.endFill();
half._x = 100;

var pixels = new flash.display.BitmapData(6, 6, false, 0x0000ff);

function run(label, source, mode) {
  var d = new flash.display.BitmapData(12, 12, true, 0xff33cc66);
  d.draw(source, new flash.geom.Matrix(), new flash.geom.ColorTransform(), mode);
  var s = label;
  for (var x = 0; x < 12; x++) {
    var p = d.getPixel32(x, 6);
    s += " " + ((p >> 24) & 255) + "," + ((p >> 16) & 255) + "," + ((p >> 8) & 255) + "," + (p & 255);
  }
  trace(s);
}

run("normal", square, "normal");
run("erase", square, "erase");
run("erase 12", square, 12);
run("alpha", square, "alpha");
run("erase half", half, "erase");
run("alpha half", half, "alpha");
run("erase BitmapData", pixels, "erase");
run("alpha BitmapData", pixels, "alpha");

// What Flash draws with a matrix or a colour transform left null or undefined.
function probe(label, matrix, ct) {
  var d = new flash.display.BitmapData(12, 12, true, 0xff33cc66);
  d.draw(square, matrix, ct, "normal");
  d.draw(square, matrix, ct, "erase");
  trace(label + " " + ((d.getPixel32(6, 6) >> 24) & 255) + " " + (d.getPixel32(6, 6) & 255));
}

probe("null matrix", null, new flash.geom.ColorTransform());
probe("undefined matrix", undefined, new flash.geom.ColorTransform());
probe("null transform", new flash.geom.Matrix(), null);
probe("undefined transform", new flash.geom.Matrix(), undefined);
var alone = new flash.display.BitmapData(12, 12, true, 0xff33cc66);
alone.draw(square, null);
trace("null matrix alone " + (alone.getPixel32(6, 6) & 255));
alone.draw(pixels, null);
trace("null matrix BitmapData " + (alone.getPixel32(1, 1) & 255));

// What draw returns: 0 drawn, -2 for no source, -3 for a disposed one, and -4
// for a matrix given as null or undefined, whatever the source.
var target = new flash.display.BitmapData(4, 4, true, 0);
var gone = new flash.display.BitmapData(4, 4, true, 0);
gone.dispose();
trace("no source, null matrix " + target.draw(undefined, null));
trace("no source, matrix " + target.draw(undefined, new flash.geom.Matrix()));
trace("no source " + target.draw(undefined));
trace("object, undefined matrix " + target.draw({}, undefined));
trace("object, matrix " + target.draw({}, new flash.geom.Matrix()));
trace("disposed, null matrix " + target.draw(gone, null));
trace("disposed " + target.draw(gone));
trace("clip, null matrix " + target.draw(square, null));
trace("clip " + target.draw(square));
trace("BitmapData " + target.draw(pixels));
