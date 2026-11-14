package
{
	import flash.display.BitmapData;
	import flash.display.Sprite;
	import flash.display.Stage3D;
	import flash.display3D.Context3D;
	import flash.display3D.IndexBuffer3D;
	import flash.display3D.Program3D;
	import flash.display3D.VertexBuffer3D;
	import flash.display3D.textures.Texture;
	import flash.events.Event;
	import flash.utils.ByteArray;

	// What AGAL 2 and 3 programs draw: conditionals, derivatives, depth output, the
	// larger register files, and what AGAL 1 already allowed but swf2es did not.
	public class AGALStandard extends Sprite
	{
		public var complete:Boolean = false;
		private static const VERBOSE:Boolean = false;
		private var c:Context3D;
		private var quad:VertexBuffer3D;
		private var indices:IndexBuffer3D;
		private var pixels:BitmapData;
		private var texture:Texture;
		private var target:Texture;
		private var shower:Program3D;

		// mov op, va0; mov v0, va1: the quad, its uv in v0, (0, 0) at the top left.
		private static const QUAD:Array = [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x040f0000, 0xe4000001, 0, 0, 0]];
		private static const OUT:Array = [0, 0x030f0000, 0xe4000000, 2, 0, 0];
		private static const EIF:Array = [0x21, 0, 0, 0, 0, 0];
		private static const ELS:Array = [0x20, 0, 0, 0, 0, 0];

		public function AGALStandard()
		{
			var slot:Stage3D = stage.stage3Ds[0];
			slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void
				{
					c = slot.context3D;
					c.enableErrorChecking = true;
					c.configureBackBuffer(64, 64, 0, true);
					quad = c.createVertexBuffer(4, 4);
					quad.uploadFromVector(Vector.<Number>([-1, 1, 0, 0, 1, 1, 1, 0, 1, -1, 1, 1, -1, -1, 0, 1]), 0, 4);
					indices = c.createIndexBuffer(6);
					indices.uploadFromVector(Vector.<uint>([0, 1, 2, 0, 2, 3]), 0, 6);
					c.setVertexBufferAt(0, quad, 0, "float2");
					c.setVertexBufferAt(1, quad, 2, "float2");
					pixels = new BitmapData(64, 64, true, 0);
					var colours:BitmapData = new BitmapData(2, 2, true, 0);
					colours.setPixel32(0, 0, 0xffff0000);
					colours.setPixel32(1, 0, 0xff00ff00);
					colours.setPixel32(0, 1, 0xff0000ff);
					colours.setPixel32(1, 1, 0xffffffff);
					texture = c.createTexture(2, 2, "bgra", false);
					texture.uploadFromBitmapData(colours);
					target = c.createTexture(64, 64, "bgra", true);
					shower = upload(1, QUAD, [[0x28, 0x030f0000, 0xe4000000, 4, 0, 5]]);
					run();
					c.dispose(false);
					complete = true;
					trace("agalstandard complete");
				});
			slot.requestContext3D("auto", "standardExtended");
		}

		private function agal(version:int, fragment:Boolean, rows:Array):ByteArray
		{
			var b:ByteArray = new ByteArray();
			b.endian = "littleEndian";
			b.writeByte(0xa0);
			b.writeUnsignedInt(version);
			b.writeByte(0xa1);
			b.writeByte(fragment ? 1 : 0);
			for (var i:int = 0; i < rows.length; i++)
			{
				for (var j:int = 0; j < 6; j++)
				{
					b.writeUnsignedInt(rows[i][j]);
				}
			}
			return b;
		}

		private function upload(version:int, vertex:Array, fragment:Array):Program3D
		{
			var p:Program3D = c.createProgram();
			p.upload(agal(version, false, vertex), agal(version, true, fragment));
			return p;
		}

		private function fc(index:int, values:Array):void
		{
			c.setProgramConstantsFromVector("fragment", index, Vector.<Number>(values));
		}

		private function vc(index:int, values:Array):void
		{
			c.setProgramConstantsFromVector("vertex", index, Vector.<Number>(values));
		}

		private function read(label:String):void
		{
			c.drawToBitmapData(pixels);
			trace("agalstandard", label, pixels.getPixel32(16, 16).toString(16), pixels.getPixel32(48, 16).toString(16),
					pixels.getPixel32(16, 48).toString(16), pixels.getPixel32(48, 48).toString(16));
		}

		private function draw(label:String, version:int, vertex:Array, fragment:Array, toTexture:Boolean = false):void
		{
			var p:Program3D;
			try
			{
				p = upload(version, vertex, fragment);
				if (toTexture)
				{
					c.setRenderToTexture(target);
				}
				c.clear(0, 0, 0, 1);
				c.setProgram(p);
				// AIR refuses a draw with a stream its program does not read.
				var uv:Boolean = false;
				for (var row:int = 0; row < vertex.length; row++)
				{
					if (vertex[row][3] == 0 && (vertex[row][2] & 0xffff) == 1)
					{
						uv = true;
					}
				}
				c.setVertexBufferAt(1, uv ? quad : null, 2, "float2");
				c.setTextureAt(0, null);
				c.setTextureAt(15, null);
				for (var i:int = 0; i < fragment.length; i++)
				{
					if (fragment[i][0] == 0x28)
					{
						c.setTextureAt(fragment[i][4] & 0xffff, texture);
					}
				}
				c.drawTriangles(indices);
				c.setTextureAt(0, null);
				c.setTextureAt(15, null);
				if (toTexture)
				{
					c.setRenderToBackBuffer();
					c.clear(0, 0, 0, 1);
					c.setVertexBufferAt(1, quad, 2, "float2");
					c.setProgram(shower);
					c.setTextureAt(0, target);
					c.drawTriangles(indices);
					c.setTextureAt(0, null);
				}
				read(label);
			}
			catch (e:Error)
			{
				c.setTextureAt(0, null);
				c.setTextureAt(15, null);
				c.setRenderToBackBuffer();
				trace("agalstandard", label, e.name, e.errorID);
				if (VERBOSE)
				{
					trace("message", e.message);
				}
			}
			if (p)
			{
				p.dispose();
			}
		}

		private function run():void
		{
			// fc0 the operands, fc1 red, fc2 blue, fc3 green, fc4 white, fc5 a half.
			fc(1, [1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5]);
			var start:Array = [0, 0x020f0000, 0xe4000002, 1, 0, 0];
			var red:Array = [0, 0x020f0000, 0xe4000001, 1, 0, 0];
			var green:Array = [0, 0x020f0000, 0xe4000003, 1, 0, 0];
			var white:Array = [0, 0x020f0000, 0xe4000004, 1, 0, 0];
			var op:int;
			for each (op in [0x1c, 0x1d, 0x1e, 0x1f])
			{
				for each (var pair:Array in [[1, 1], [1, 2], [2, 1], [-0, 0]])
				{
					fc(0, [pair[0], pair[1], 0, 0]);
					draw("if" + op.toString(16) + "-" + pair[0] + "-" + pair[1], 2, QUAD,
							[start, [op, 0, 0x00000000, 1, 0x55000000, 1], red, EIF, OUT]);
				}
			}
			fc(0, [0.5, 0, 0, -1]);
			draw("if-varying-else", 2, QUAD, [start, [0x1e, 0, 0x00000000, 4, 0x00000000, 1], red, ELS, green, EIF, OUT]);
			draw("if-nested", 2, QUAD, [start, [0x1f, 0, 0x00000000, 4, 0x00000000, 1],
						[0x1f, 0, 0x55000000, 4, 0x00000000, 1], red, ELS, green, EIF, ELS, white, EIF, OUT]);
			draw("if-kil", 2, QUAD, [[0, 0x020f0001, 0xe4000000, 1, 0, 0], red, [0x1e, 0, 0x00000000, 4, 0x00000000, 1],
						[0x27, 0, 0xff000001, 2, 0, 0], EIF, OUT]);
			draw("if-tex", 2, QUAD, [start, [0x1e, 0, 0x00000000, 4, 0x00000000, 1],
						[0x28, 0x020f0000, 0xe4000000, 4, 0, 5], EIF, OUT]);
			draw("if-partial", 2, QUAD, [start, [0x1e, 0, 0x00000000, 4, 0x00000000, 1],
						[0, 0x02010000, 0xe4000004, 1, 0, 0], ELS, [0, 0x02020000, 0xe4000004, 1, 0, 0], EIF, OUT]);
			draw("if-temp-read", 2, QUAD, [start, [0x1e, 0, 0x00000000, 4, 0x00000000, 1],
						[1, 0x020f0000, 0xe4000000, 2, 0xe4000001, 1], EIF, OUT]);
			draw("if-unwritten-operand", 2, QUAD, [start, [0x1c, 0, 0x00000005, 2, 0x00000005, 2], red, EIF, OUT]);

			// Derivatives of uv across 64 pixels, as 0.5 + 32 * d.
			fc(6, [32, 32, 32, 32, 0.5, 0.5, 0.5, 1]);
			for each (op in [0x1a, 0x1b])
			{
				var derivative:Array = [[op, 0x020f0000, 0xe4000000, 4, 0, 0], [3, 0x020f0000, 0xe4000000, 2, 0xe4000006, 1],
						[1, 0x020f0000, 0xe4000000, 2, 0xe4000007, 1], [0, 0x02080000, 0xff000007, 1, 0, 0], OUT];
				draw("d" + op.toString(16), 2, QUAD, derivative);
				draw("d" + op.toString(16) + "-texture", 2, QUAD, derivative, true);
			}
			draw("ddx-constant", 2, QUAD, [[0x1a, 0x020f0000, 0xe4000000, 1, 0, 0], OUT]);
			draw("ddx-temporary", 2, QUAD, [[0, 0x020f0000, 0xe4000000, 4, 0, 0], [0x1a, 0x020f0000, 0xe4000000, 2, 0, 0],
						[3, 0x020f0000, 0xe4000000, 2, 0xe4000006, 1], [1, 0x020f0000, 0xe4000000, 2, 0xe4000007, 1],
						[0, 0x02080000, 0xff000007, 1, 0, 0], OUT]);

			// Depth output: a quad at depth 0.5 writes od, then green at 0.4 passes where od > 0.4.
			c.setDepthTest(true, "less");
			var deep:Array = [[0, 0x020f0000, 0xe4000000, 0, 0, 0], [0, 0x02040000, 0x00000000, 1, 0, 0],
					[0, 0x030f0000, 0xe4000000, 2, 0, 0], [0, 0x040f0000, 0xe4000001, 0, 0, 0]];
			var greenAt:Program3D = upload(1, deep, [[0, 0x030f0000, 0xe4000003, 1, 0, 0]]);
			for each (var depth:Number in [0.25, 0.75, 1.5, -0.5])
			{
				var p:Program3D;
				try
				{
					p = upload(2, deep, [[0, 0x030f0000, 0xe4000001, 1, 0, 0], [0, 0x06010000, 0x00000000, 1, 0, 0]]);
					c.clear(0, 0, 0, 1, 1);
					fc(0, [depth, 0, 0, 0]);
					vc(0, [0.5, 0, 0, 0]);
					c.setProgram(p);
					c.drawTriangles(indices);
					vc(0, [0.4, 0, 0, 0]);
					c.setProgram(greenAt);
					c.drawTriangles(indices);
					read("od-" + depth);
				}
				catch (e:Error)
				{
					trace("agalstandard", "od-" + depth, e.name, e.errorID);
				}
				if (p)
				{
					p.dispose();
				}
			}
			try
			{
				// Depth from a varying, 0 at the left to 1 at the right.
				p = upload(2, deep, [[0, 0x030f0000, 0xe4000001, 1, 0, 0], [0, 0x06010000, 0x00000000, 4, 0, 0]]);
				c.clear(0, 0, 0, 1, 1);
				vc(0, [0.5, 0, 0, 0]);
				c.setProgram(p);
				c.drawTriangles(indices);
				vc(0, [0.4, 0, 0, 0]);
				c.setProgram(greenAt);
				c.drawTriangles(indices);
				read("od-varying");
				p.dispose();
			}
			catch (e:Error)
			{
				trace("agalstandard", "od-varying", e.name, e.errorID);
			}
			greenAt.dispose();
			c.setDepthTest(false, "always");

			// The larger register files.
			vc(249, [0.25, 0.5, 0.75, 1]);
			vc(127, [0.5, 0.5, 0.5, 1]);
			fc(63, [0.75, 0.5, 0.25, 1]);
			fc(199, [0.5, 0.25, 0.75, 1]);
			draw("v9", 2, [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x040f0009, 0xe4000001, 0, 0, 0]],
					[[0, 0x030f0000, 0xe4000009, 4, 0, 0]]);
			draw("vc249", 2, [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x040f0000, 0xe40000f9, 1, 0, 0]],
					[[0, 0x030f0000, 0xe4000000, 4, 0, 0]]);
			draw("vt25", 2, [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x020f0019, 0xe40000f9, 1, 0, 0],
						[0, 0x040f0000, 0xe4000019, 2, 0, 0]], [[0, 0x030f0000, 0xe4000000, 4, 0, 0]]);
			draw("fc63", 2, QUAD, [[0, 0x030f0000, 0xe400003f, 1, 0, 0]]);
			draw("ft25", 2, QUAD, [[0, 0x020f0019, 0xe400003f, 1, 0, 0], [0, 0x030f0000, 0xe4000019, 2, 0, 0]]);
			draw("fs15", 2, QUAD, [[0x28, 0x020f0000, 0xe4000000, 4, 15, 5], OUT]);
			draw("fc199", 3, QUAD, [[0, 0x030f0000, 0xe40000c7, 1, 0, 0]]);
			c.setVertexBufferAt(15, quad, 2, "float2");
			draw("va15", 3, [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x040f0000, 0xe400000f, 0, 0, 0]],
					[[0, 0x030f0000, 0xe4000000, 4, 0, 0]]);
			c.setVertexBufferAt(15, null);
			// The stream va15 read, but va1 then unread.
			c.setVertexBufferAt(15, quad, 2, "float2");
			draw("va15-unread", 3, QUAD, [[0, 0x030f0000, 0xe4000000, 4, 0, 0]]);
			c.setVertexBufferAt(15, null);
			draw("iid", 2, [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x020f0000, 0x00000000, 7, 0, 0],
						[1, 0x040f0000, 0xe4000000, 2, 0xe40000f9, 1]], [[0, 0x030f0000, 0xe4000000, 4, 0, 0]]);
			draw("iid-v1", 1, [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x020f0000, 0x00000000, 7, 0, 0],
						[1, 0x040f0000, 0xe4000000, 2, 0xe400007f, 1]], [[0, 0x030f0000, 0xe4000000, 4, 0, 0]]);

			// Indirect reads past 127, by an offset up to 255.
			vc(0, [0, 49, 0, 0]);
			vc(130, [0, 1, 0, 1]);
			vc(200, [1, 0, 1, 1]);
			for each (var version:int in [1, 2])
			{
				draw("indirect-130-v" + version, version, [[0, 0x030f0000, 0xe4000000, 0, 0, 0],
							[0, 0x040f0000, 0xe4820000, 0x80000101, 0, 0]], [[0, 0x030f0000, 0xe4000000, 4, 0, 0]]);
				draw("indirect-249-v" + version, version, [[0, 0x030f0000, 0xe4000000, 0, 0, 0],
							[0, 0x040f0000, 0xe4c80000, 0x80010101, 0, 0]], [[0, 0x030f0000, 0xe4000000, 4, 0, 0]]);
				draw("indirect-200-v" + version, version, [[0, 0x030f0000, 0xe4000000, 0, 0, 0],
							[0, 0x040f0000, 0xe4c80000, 0x80000101, 0, 0]], [[0, 0x030f0000, 0xe4000000, 4, 0, 0]]);
			}

			// The sampler's own wrap modes, over uv from -0.5 to 1.5.
			fc(0, [2, 2, 1, 1, -0.5, -0.5, 0, 0]);
			for each (var wrap:int in [0, 1, 2, 3])
			{
				draw("wrap-" + wrap, 1, QUAD, [[3, 0x020f0000, 0xe4000000, 4, 0xe4000000, 1], [1, 0x020f0000, 0xe4000000, 2, 0xe4000001, 1],
							[0x28, 0x030f0000, 0xe4000000, 2, 0, 5 | (wrap << 20)]]);
			}
		}
	}
}
