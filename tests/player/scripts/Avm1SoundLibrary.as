// An AVM1 movie that loads another, each exporting a sound, itself in this
// Loader (cases/avm1.ts, avm1-sound-library).
package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.net.URLRequest;

	public class Main extends Sprite
	{
		public function Main()
		{
			var loader:Loader = new Loader();
			addChild(loader);
			loader.load(new URLRequest("avm1-sound-library-parent.swf"));
		}
	}
}
