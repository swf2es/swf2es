// An AVM1 movie whose Sounds find their targets, in this Loader
// (cases/avm1.ts, avm1-sound-targets).
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
			loader.load(new URLRequest("avm1-sound-targets-movie.swf"));
		}
	}
}
