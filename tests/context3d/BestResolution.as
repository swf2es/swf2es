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
	import flash.geom.Rectangle;
	import flash.utils.ByteArray;

	// configureBackBuffer's wantsBestResolution and wantsBestResolutionOnBrowserZoom on a screen of
	// twice the density, as AIR runs it with requestedDisplayResolution high at 192 DPI: the back
	// buffer's size, what drawToBitmapData reads, the scissor rectangle's unit and the sizes
	// refused, all in the screen's pixels.
	public class BestResolution extends Sprite
	{
		public var complete:Boolean = false;
		private var context:Context3D;
		private var indices:IndexBuffer3D;
		private var pixels:BitmapData = new BitmapData(160, 160, true, 0);

		public function BestResolution()
		{
			if (stage)
			{
				start();
			}
			else
			{
				addEventListener(Event.ADDED_TO_STAGE, start);
			}
		}

		private function start(event:Event = null):void
		{
			removeEventListener(Event.ADDED_TO_STAGE, start);
			trace("bestresolution scale", stage.contentsScaleFactor, stage.browserZoomFactor);
			var slot:Stage3D = stage.stage3Ds[0];
			slot.addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void
				{
					context = slot.context3D;
					context.enableErrorChecking = true;
					var vertices:VertexBuffer3D = context.createVertexBuffer(4, 4);
					vertices.uploadFromVector(Vector.<Number>([-1, -1, 0, 1, 1, -1, 0, 1, 1, 1, 0, 1, -1, 1, 0, 1]), 0, 4);
					indices = context.createIndexBuffer(6);
					indices.uploadFromVector(Vector.<uint>([0, 1, 2, 0, 2, 3]), 0, 6);
					context.setVertexBufferAt(0, vertices, 0, "float4");
					var program:Program3D = context.createProgram();
					program.upload(shader(false), shader(true));
					context.setProgram(program);
					run();
					context.dispose(false);
					vertices.dispose();
					indices.dispose();
					program.dispose();
					pixels.dispose();
					complete = true;
					trace("bestresolution complete");
				});
			slot.requestContext3D("auto", "baseline");
		}

		private function shader(fragment:Boolean):ByteArray
		{
			var bytes:ByteArray = new ByteArray();
			bytes.endian = "littleEndian";
			bytes.writeByte(0xa0);
			bytes.writeUnsignedInt(1);
			bytes.writeByte(0xa1);
			bytes.writeByte(fragment ? 1 : 0);
			bytes.writeUnsignedInt(0);
			bytes.writeUnsignedInt(0x030f0000);
			bytes.writeUnsignedInt(0xe4000000);
			bytes.writeUnsignedInt(fragment ? 1 : 0);
			bytes.writeUnsignedInt(0);
			bytes.writeUnsignedInt(0);
			return bytes;
		}

		private function bounds(color:uint):String
		{
			var r:Rectangle = pixels.getColorBoundsRect(0xffffffff, color, true);
			return r.x + "," + r.y + "," + r.width + "x" + r.height;
		}

		private function sizes():String
		{
			return context.backBufferWidth + "x" + context.backBufferHeight + " most " +
				context.maxBackBufferWidth + "x" + context.maxBackBufferHeight;
		}

		/** Blue cleared, red drawn inside `rect`, and where each landed, read at the back buffer's pixels. */
		private function scissored(label:String, rect:Rectangle):void
		{
			try
			{
				context.setScissorRectangle(null);
				context.clear(0, 0, 1, 1);
				context.setScissorRectangle(rect);
				context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 1]));
				context.drawTriangles(indices);
				context.setScissorRectangle(null);
				pixels.fillRect(pixels.rect, 0);
				context.drawToBitmapData(pixels);
				trace("bestresolution", label, "blue", bounds(0xff0000ff), "red", bounds(0xffff0000));
			}
			catch (error:Error)
			{
				context.setScissorRectangle(null);
				trace("bestresolution", label, error.name, error.errorID);
			}
		}

		private function frame(label:String, width:int, height:int, best:Boolean, zoom:Boolean):void
		{
			try
			{
				context.configureBackBuffer(width, height, 0, false, best, zoom);
				trace("bestresolution", label, "configured", sizes());
			}
			catch (error:Error)
			{
				trace("bestresolution", label, error.name, error.errorID, sizes());
				return;
			}

			scissored(label, new Rectangle(0, 0, 10, 10));
			var small:BitmapData = new BitmapData(20, 20, true, 0);
			context.drawToBitmapData(small);
			trace("bestresolution", label, "small", small.getPixel32(5, 5).toString(16), small.getPixel32(15, 15).toString(16));
			small.dispose();
			context.present();
		}

		private function run():void
		{
			frame("plain", 64, 48, false, false);
			frame("best", 64, 48, true, false);
			frame("zoom", 64, 48, false, true);
			frame("both", 64, 48, true, true);
			frame("odd", 33, 47, true, false);
			frame("least", 32, 32, true, false);
			frame("below-least", 20, 31, true, false);
			frame("plain-again", 64, 48, false, false);

			// The scissor rectangle is in stage pixels, set before or after the configure.
			context.configureBackBuffer(64, 48, 0, false, false);
			context.setScissorRectangle(new Rectangle(0, 0, 10, 10));
			context.configureBackBuffer(64, 48, 0, false, true);
			context.clear(0, 0, 1, 1);
			context.setProgramConstantsFromVector("fragment", 0, Vector.<Number>([1, 0, 0, 1]));
			context.drawTriangles(indices);
			context.setScissorRectangle(null);
			pixels.fillRect(pixels.rect, 0);
			context.drawToBitmapData(pixels);
			trace("bestresolution scissor-before red", bounds(0xffff0000));
			scissored("scissor-fraction", new Rectangle(3, 5, 11, 7));
			scissored("scissor-rounded", new Rectangle(3.3, 5.6, 11.25, 7.75));
			scissored("scissor-edge", new Rectangle(60, 40, 10, 10));
			scissored("scissor-outside", new Rectangle(70, 50, 10, 10));

			// A texture's scissor is in its own pixels.
			var texture:Texture = context.createTexture(32, 32, "bgra", true);
			context.setRenderToTexture(texture);
			context.clear(0, 1, 0, 1);
			context.setScissorRectangle(new Rectangle(20, 20, 5, 5));
			try
			{
				context.drawTriangles(indices);
				trace("bestresolution texture-scissor drawn");
			}
			catch (error:Error)
			{
				trace("bestresolution texture-scissor", error.name, error.errorID);
			}
			context.setScissorRectangle(null);
			context.setRenderToBackBuffer();
			texture.dispose();
			trace("bestresolution after-texture", sizes());

			// maxBackBufferWidth and maxBackBufferHeight hold the screen's pixels.
			context.maxBackBufferWidth = 100;
			trace("bestresolution most", sizes());
			frame("over-most", 64, 48, true, false);
			frame("at-most", 50, 48, true, false);
			frame("plain-under-most", 64, 48, false, false);
			context.maxBackBufferWidth = 16384;
			context.maxBackBufferHeight = 16384;
			frame("over-limit", 9000, 48, true, false);
			frame("plain-at-limit", 9000, 48, false, false);
			frame("tall-over-limit", 48, 8193, true, false);
			frame("last", 64, 48, true, false);
		}
	}
}
