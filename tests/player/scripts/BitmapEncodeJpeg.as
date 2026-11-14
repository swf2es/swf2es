package
{
	import flash.display.Bitmap;
	import flash.display.BitmapData;
	import flash.display.JPEGEncoderOptions;
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.geom.Rectangle;
	import flash.utils.ByteArray;

	// BitmapData.encode as JPEG (cases.ts): the file's segments and tables at
	// each quality, which are Flash's byte for byte; the whole file where the
	// picture is flat or the quality low, where it is too; what the method
	// refuses; and the files loaded back and shown, as Flash decodes its own.
	public class BitmapEncodeJpeg extends Sprite
	{
		private var shown:int = 0;

		public function BitmapEncodeJpeg()
		{
			trace("default quality", new JPEGEncoderOptions().quality);

			var bd:BitmapData = picture(96, 64, false);
			for each (var q:int in [0, 1, 10, 19, 20, 23, 24, 25, 50, 80, 90, 100])
			{
				var file:ByteArray = bd.encode(bd.rect, new JPEGEncoderOptions(q));
				trace("quality", q, segments(file));
			}

			// The tables themselves, at the default quality.
			var eighty:ByteArray = bd.encode(bd.rect, new JPEGEncoderOptions());
			trace("tables", hex(eighty, 20, 138));

			// Flat pictures, a block past the picture's edge, and a picture at the qualities that
			// leave no coefficient near a rounding boundary: Flash's bytes.
			whole("grey", new BitmapData(8, 8, false, 0x808080), 80);
			whole("white", new BitmapData(8, 8, false, 0xFFFFFF), 80);
			whole("black", new BitmapData(8, 8, false, 0x000000), 100);
			whole("red", new BitmapData(8, 8, false, 0xFF0000), 100);
			whole("green", new BitmapData(8, 8, false, 0x00FF00), 100);
			whole("blue", new BitmapData(8, 8, false, 0x0000FF), 100);
			whole("one pixel", new BitmapData(1, 1, false, 0x336699), 80);
			whole("seventeen by nine", new BitmapData(17, 9, false, 0xCC8844), 90);
			whole("half alpha", new BitmapData(16, 16, true, 0x80FF8040), 90);
			whole("no alpha", new BitmapData(16, 16, true, 0x00000000), 90);
			whole("picture at 1", bd, 1);
			whole("picture at 10", bd, 10);

			var part:ByteArray = bd.encode(new Rectangle(3.5, 2.5, 17.4, 9.6), new JPEGEncoderOptions(80));
			trace("part", segments(part));
			var clipped:ByteArray = bd.encode(new Rectangle(-5, 60, 20, 20), new JPEGEncoderOptions(80));
			trace("clipped", segments(clipped));

			var one:BitmapData = new BitmapData(1, 1, false, 0x336699);
			var made:ByteArray = one.encode(one.rect, new JPEGEncoderOptions(80));
			trace("new", made.length, made.position, made.endian);
			var into:ByteArray = new ByteArray();
			into.writeUTFBytes("abcdef");
			into.position = 2;
			var back:ByteArray = one.encode(one.rect, new JPEGEncoderOptions(80), into);
			trace("into", back == into, into.length, into.position, hex(into, 0, 6), hex(into, into.length - 2, 2));

			var past:JPEGEncoderOptions = new JPEGEncoderOptions(101);
			probe("quality 101", function():*
				{
					bd.encode(bd.rect, past);
				});
			probe("quality 1000", function():*
				{
					bd.encode(bd.rect, new JPEGEncoderOptions(1000));
				});
			probe("quality -1", function():*
				{
					bd.encode(bd.rect, new JPEGEncoderOptions(-1));
				});
			probe("quality 101, null rect", function():*
				{
					bd.encode(null, past);
				});
			probe("quality 101, empty rect", function():*
				{
					bd.encode(new Rectangle(0, 0, 0, 0), past);
				});
			probe("null rect", function():*
				{
					bd.encode(null, new JPEGEncoderOptions());
				});
			probe("empty rect", function():*
				{
					bd.encode(new Rectangle(0, 0, 0, 0), new JPEGEncoderOptions());
				});
			probe("outside", function():*
				{
					bd.encode(new Rectangle(100, 100, 2, 2), new JPEGEncoderOptions());
				});
			probe("negative", function():*
				{
					bd.encode(new Rectangle(2, 2, -1, -1), new JPEGEncoderOptions());
				});
			var gone:BitmapData = new BitmapData(1, 1);
			gone.dispose();
			probe("disposed", function():*
				{
					gone.encode(new Rectangle(0, 0, 1, 1), new JPEGEncoderOptions());
				});
			probe("disposed, quality 101", function():*
				{
					gone.encode(new Rectangle(0, 0, 1, 1), past);
				});

			show(bd.encode(bd.rect, new JPEGEncoderOptions(100)), 2, 2);
			show(bd.encode(bd.rect, new JPEGEncoderOptions(80)), 102, 2);
			show(bd.encode(bd.rect, new JPEGEncoderOptions(30)), 202, 2);
			show(picture(96, 64, true).encode(bd.rect, new JPEGEncoderOptions(90)), 302, 2);
		}

		// A picture of what a JPEG holds well: a gradient, flat areas with straight and slanted
		// edges between them, and a soft disc; with alpha, it fades out to the right.
		private static function picture(w:int, h:int, transparent:Boolean):BitmapData
		{
			var bd:BitmapData = new BitmapData(w, h, transparent, 0xFF000000);
			for (var y:int = 0; y < h; y++)
			{
				for (var x:int = 0; x < w; x++)
				{
					var r:int = (x * 255) / (w - 1);
					var g:int = (y * 255) / (h - 1);
					var b:int = 255 - r;
					if (x >= 8 && x < 40 && y >= 8 && y < 24)
					{
						r = 200;
						g = 40;
						b = 90;
					}
					if (x + y > 120)
					{
						r = 30;
						g = 160;
						b = 220;
					}
					var d:Number = Math.sqrt((x - 64) * (x - 64) + (y - 22) * (y - 22));
					if (d < 14)
					{
						var k:Number = d / 14;
						r = 255 - 200 * k;
						g = 240 - 100 * k;
						b = 60;
					}
					var a:int = transparent ? 255 - (x * 255) / (w - 1) : 255;
					bd.setPixel32(x, y, (a << 24) | (r << 16) | (g << 8) | b);
				}
			}

			return bd;
		}

		private function show(file:ByteArray, x:int, y:int):void
		{
			var loader:Loader = new Loader();
			loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					var bitmap:BitmapData = Bitmap(loader.content).bitmapData;
					shown++;
					trace("loaded", loader.contentLoaderInfo.contentType, bitmap.width, bitmap.height, bitmap.transparent, shown);
				});
			loader.x = x;
			loader.y = y;
			addChild(loader);
			loader.loadBytes(file);
		}

		private static function whole(name:String, bd:BitmapData, quality:uint):void
		{
			var file:ByteArray = bd.encode(bd.rect, new JPEGEncoderOptions(quality));
			var scan:int = file.length;
			for (var i:int = 2; i < file.length; i += 2 + ((file[i + 2] << 8) | file[i + 3]))
			{
				if (file[i + 1] == 0xDA)
				{
					scan = i + 14;
					break;
				}
			}

			trace(name, file.length, sum(file, 0, file.length), file.length - scan <= 40 ? hex(file, scan, file.length - scan) : "");
		}

		// Each segment's marker and length, the frame's bytes, and a sum of everything up to the
		// scan's data, which holds every table.
		private static function segments(file:ByteArray):String
		{
			var out:String = hex(file, 0, 2);
			var i:int = 2;
			while (i < file.length)
			{
				var length:int = (file[i + 2] << 8) | file[i + 3];
				out += " " + hex(file, i, 2) + ":" + length;
				if (file[i + 1] == 0xC0 || file[i + 1] == 0xC1)
				{
					out += "(" + hex(file, i + 4, length - 2) + ")";
				}

				i += 2 + length;
				if (file[i - 2 - length + 1] == 0xDA)
				{
					break;
				}
			}

			return out + " head " + i + " " + sum(file, 0, i) + " end " + hex(file, file.length - 2, 2);
		}

		// Fletcher's sum of the bytes, which their order changes too.
		private static function sum(b:ByteArray, from:int, to:int):String
		{
			var s1:uint = 1;
			var s2:uint = 0;
			for (var i:int = from; i < to; i++)
			{
				s1 = (s1 + b[i]) % 65521;
				s2 = (s2 + s1) % 65521;
			}

			return (((s2 << 16) | s1) >>> 0).toString(16);
		}

		private static function probe(name:String, f:Function):void
		{
			try
			{
				f();
				trace(name, "ok");
			}
			catch (e:Error)
			{
				trace(name, Object(e).constructor, e.errorID);
			}
		}

		private static function hex(b:ByteArray, from:int, count:int):String
		{
			var out:String = "";
			for (var i:int = from; i < from + count; i++)
			{
				var s:String = b[i].toString(16);
				out += s.length < 2 ? "0" + s : s;
			}

			return out;
		}
	}
}
