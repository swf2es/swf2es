package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.net.URLRequest;

	// An AS3 host whose Loader holds the AS2 input field's movie: the page focuses the field and
	// types into it through the movie's own callbacks, as it does the movie alone.
	public class LoadedAvm1Field extends Sprite
	{
		public function LoadedAvm1Field()
		{
			var loader:Loader = new Loader();
			addChild(loader);
			loader.load(new URLRequest("/web-test/avm1-field.swf"));
		}
	}
}
