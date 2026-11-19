package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.net.URLRequest;
	// Loads children-N.swf in turn: kinds of them, each unloaded once it is
	// complete or, given keep, kept on the stage that many frames first; stop=0
	// unloads with unload() rather than unloadAndStop(); prefix names others.
	public class LeakMain extends Sprite
	{
		private var count:int = 0;
		private var loading:Boolean = false;
		public function LeakMain()
		{
			addEventListener(Event.ENTER_FRAME, next);
		}
		private function next(e:Event):void
		{
			if (loading)
			{
				return;
			}
			loading = true;
			var params:Object = loaderInfo.parameters;
			var kinds:int = int(params.kinds);
			var keep:int = int(params.keep);
			var stop:Boolean = params.stop != "0";
			var prefix:String = params.prefix || "child-";
			var loader:Loader = new Loader();
			var done:Function = function():void
				{
					if (stop)
					{
						loader.unloadAndStop();
					}
					else
					{
						loader.unload();
					}
					if (loader.parent)
					{
						removeChild(loader);
					}
					loading = false;
					count++;
					trace("loaded " + count);
				};
			loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					if (keep == 0)
					{
						done();
						return;
					}
					addChild(loader);
					var frames:int = 0;
					var wait:Function = function(e:Event):void
						{
							if (++frames >= keep)
							{
								removeEventListener(Event.ENTER_FRAME, wait);
								done();
							}
						};
					addEventListener(Event.ENTER_FRAME, wait);
				});
			loader.load(new URLRequest(prefix + (count % kinds) + ".swf"));
		}
	}
}
