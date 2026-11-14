package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.net.URLRequest;
	import flash.system.ApplicationDomain;
	import flash.system.LoaderContext;
	import flash.text.Font;
	import flash.text.TextField;
	import flash.text.TextFormat;
	public class LeakKept extends Sprite
	{
		private var field:TextField;
		private var frames:int = 0;
		public function LeakKept()
		{
			var loader:Loader = new Loader();
			loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					var child:Object = loader.contentLoaderInfo.applicationDomain.getDefinition("LeakKeptChild");
					field = child.field();
					addChild(field);
					loader.unloadAndStop();
					trace("kept");
					addEventListener(Event.ENTER_FRAME, register);
				});
			loader.load(new URLRequest("kept-child.swf"));
		}
		private function register(e:Event):void
		{
			if (++frames < 2)
			{
				return;
			}
			removeEventListener(Event.ENTER_FRAME, register);
			var loader:Loader = new Loader();
			loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					Font.registerFont(loader.contentLoaderInfo.applicationDomain.getDefinition("LeakProbe") as Class);
					field.text = "ab";
					var fresh:TextField = new TextField();
					fresh.embedFonts = true;
					fresh.defaultTextFormat = new TextFormat("Probe", 20);
					fresh.text = "ab";
					trace(field.textWidth + " " + fresh.textWidth);
				});
			loader.load(new URLRequest("kept-font.swf"), new LoaderContext(false, new ApplicationDomain()));
		}
	}
}
