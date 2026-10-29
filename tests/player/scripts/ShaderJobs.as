// Pixel Bender kernels run by ShaderJob over a BitmapData, as Flash draws
// them: a twirl sampled linearly, a 3x3 matrix mixing channels into an
// opaque output, a checkerboard of ints and branches whose colours exceed
// its alpha, floats from a Vector stretched linearly, and the twirl again,
// asynchronously, shown once it completes. The kernels are the case's
// (cases.ts, shaderJobs), each bound to a ByteArray subclass.
package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Shader;
  import flash.display.ShaderJob;
  import flash.display.Sprite;
  import flash.events.ShaderEvent;

  public class ShaderJobs extends Sprite {
    public function ShaderJobs() {
      var source:BitmapData = new BitmapData(40, 40, true, 0);
      for (var y:int = 0; y < 40; y++) {
        for (var x:int = 0; x < 40; x++) {
          var stripe:uint = ((x >> 2) + (y >> 2)) % 2 ? 0x40 : 0xc0;
          source.setPixel32(x, y, ((255 - y * 3) << 24) | (x * 6 << 16) | (y * 6 << 8) | stripe);
        }
      }

      show(source, 0, "source");

      var twirl:BitmapData = new BitmapData(40, 40, true, 0);
      var shader:Shader = new Shader(new TwirlKernel());
      shader.data.src.input = source;
      new ShaderJob(shader, twirl).start(true);
      show(twirl, 1, null);

      var mixed:BitmapData = new BitmapData(40, 40, false, 0);
      var mixer:Shader = new Shader(new MixerKernel());
      mixer.data.src.input = source;
      mixer.data.m.value = [0.2, 0.7, 0.1, 0.6, 0.2, 0.2, 0.1, 0.1, 0.5];
      new ShaderJob(mixer, mixed).start(true);
      show(mixed, 2, "mixed");

      var checker:BitmapData = new BitmapData(40, 40, true, 0xff000000);
      var board:Shader = new Shader(new CheckerKernel());
      board.data.size.value = [5];
      new ShaderJob(board, checker).start(true);
      show(checker, 3, "checker");

      var floats:Vector.<Number> = new <Number>[1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 0.5];
      var stretched:BitmapData = new BitmapData(40, 40, true, 0);
      var gradient:Shader = new Shader(new StretchKernel());
      gradient.data.src.input = floats;
      gradient.data.src.width = 2;
      gradient.data.src.height = 2;
      gradient.data.scale.value = [0.05, 0.05];
      new ShaderJob(gradient, stretched).start(true);
      show(stretched, 4, "stretched");

      var later:BitmapData = new BitmapData(40, 40, true, 0xffff0000);
      var again:Shader = new Shader(new TwirlKernel());
      again.data.src.input = source;
      again.data.amount.value = [-0.1];
      var job:ShaderJob = new ShaderJob(again, later);
      job.addEventListener(ShaderEvent.COMPLETE, function(e:ShaderEvent):void {
        trace("complete " + (e.bitmapData == later));
      });
      job.start();
      show(later, 5, null);
    }

    private function show(b:BitmapData, at:int, label:String):void {
      var bitmap:Bitmap = new Bitmap(b);
      bitmap.x = at * 45;
      addChild(bitmap);
      if (label) {
        var row:Array = [];
        for (var x:int = 0; x < 40; x += 7) {
          row.push(b.getPixel32(x, x).toString(16));
        }

        trace(label, row.join(" "));
      }
    }
  }
}
