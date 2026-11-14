package
{
	import flash.desktop.NativeApplication;
	import flash.filesystem.File;
	import flash.filesystem.FileMode;
	import flash.filesystem.FileStream;
	import flash.utils.setInterval;
	import flash.utils.setTimeout;
	public class Reference extends Composition
	{
		public function Reference()
		{
			super();
			stage.nativeWindow.activate();
			var previous:int = -1;
			setInterval(function():void
				{
					if (!ready)
					{
						return;
					}
					var stream:FileStream = new FileStream();
					stream.open(File.applicationDirectory.resolvePath("step.txt"), FileMode.READ);
					var step:int = int(stream.readUTFBytes(stream.bytesAvailable));
					stream.close();
					if (step == previous)
					{
						return;
					}
					previous = step;
					if (step == 9)
					{
						NativeApplication.nativeApplication.exit(0);
						return;
					}
					advance(step);
					setTimeout(function():void
						{
							trace("capture", step);
						}, 300);
				}, 100);
		}
	}
}
