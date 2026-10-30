// A BitmapData drawn into itself from AVM1 (draw-bitmaps' self probe, AS3):
// each move's pixels after the draw, to tell a row at a time from scan order.

function dump(b) {
  var s = "";
  for (var y = 0; y < b.height; y++) {
    for (var x = 0; x < b.width; x++) {
      s += " " + ((b.getPixel32(x, y) >> 4) & 15);
    }
    s += " |";
  }
  return s;
}

var moves = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0]];
for (var i = 0; i < moves.length; i++) {
  var self = new flash.display.BitmapData(4, 3, true, 0);
  for (var k = 0; k < 12; k++) {
    self.setPixel32(k % 4, Math.floor(k / 4), 0xff000000 | ((k + 1) * 16));
  }
  self.draw(self, new flash.geom.Matrix(1, 0, 0, 1, moves[i][0], moves[i][1]));
  trace("self " + moves[i].join(",") + dump(self));
}
