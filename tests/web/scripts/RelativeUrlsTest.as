package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.IOErrorEvent;
	import flash.external.ExternalInterface;
	import flash.net.URLLoader;
	import flash.net.URLRequest;

	// The web test's AS3 SWF in sub/: tells the page what a relative URL
	// loaded, its text saying from where, or "missing".
	public class RelativeUrlsTest extends Sprite
	{
		private var _loader:URLLoader = new URLLoader();

		public function RelativeUrlsTest()
		{
			_loader.addEventListener(Event.COMPLETE, loaded);
			_loader.addEventListener(IOErrorEvent.IO_ERROR, missing);
			_loader.load(new URLRequest("relative-url-data.txt"));
		}

		private function loaded(e:Event):void
		{
			ExternalInterface.call("report", "as3 " + String(_loader.data));
		}

		private function missing(e:Event):void
		{
			ExternalInterface.call("report", "as3 missing");
		}
	}
}
