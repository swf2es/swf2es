package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.external.ExternalInterface;
	import flash.net.URLRequest;
	import flash.system.fscommand;

	// An AS3 host using ExternalInterface and fscommand while the AS2 movie its Loader holds uses
	// them too: each reaches the page, and the page reaches each one's callbacks.
	public class LoadedAvm1External extends Sprite
	{
		public function LoadedAvm1External()
		{
			ExternalInterface.addCallback("hostDouble", function(n:Number):Number
				{
					return n * 2;
				});
			ExternalInterface.call("loadedCall", "host", ExternalInterface.call("loadedCall", "host first"));
			fscommand("hostCommand", "host args");
			var loader:Loader = new Loader();
			addChild(loader);
			loader.load(new URLRequest("/web-test/loaded-external-child.swf"));
		}
	}
}
