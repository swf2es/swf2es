package
{
	import flash.display.DisplayObject;
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.IOErrorEvent;
	import flash.net.URLRequest;
	import flash.system.ApplicationDomain;
	import flash.system.LoaderContext;
	import flash.utils.getDefinitionByName;

	// Plays codegen-session.ts's plan, its parameter: a load at a time, each
	// "domain:file:class", the domain c for this SWF's, s for a child of it
	// shared by every such load, n for a child of its own, then for a map
	// the file and class of an asset it loads into its own domain once it
	// is loaded. Each loaded class is made and put on the stage; a map (n)
	// stays until the next map comes and is then unloaded, an item's Loader
	// and instance are let go of KEEP loads later. Traces "loaded N" after
	// each.
	public class SesLoads extends Sprite
	{
		private static const KEEP:int = 3;

		private var _plan:Array;
		private var _at:int = 0;
		private var _loading:Boolean = false;
		private var _shared:ApplicationDomain;
		private var _items:Array = [];
		private var _map:Sprite;
		private var _main:Object;

		public function SesLoads()
		{
			// The main SWF's own code, in an ABC of its own before this one.
			_main = new (getDefinitionByName("SesMain") as Class)();
			_shared = new ApplicationDomain(ApplicationDomain.currentDomain);
			_plan = String(loaderInfo.parameters.plan).split(",");
			addEventListener(Event.ENTER_FRAME, next);
		}

		private function next(e:Event):void
		{
			if (_loading || _at >= _plan.length)
			{
				return;
			}

			_loading = true;
			const step:Array = String(_plan[_at++]).split(":");
			const kind:String = step[0];
			const domain:ApplicationDomain = kind == "c" ? ApplicationDomain.currentDomain : kind == "s" ? _shared : new ApplicationDomain(ApplicationDomain.currentDomain);
			const holder:Sprite = new Sprite();
			load(holder, step[1], step[2], domain, function(loaded:Loader):void
				{
					if (step.length < 5)
					{
						done(kind, holder);
						return;
					}

					load(holder, step[3], step[4], loaded.contentLoaderInfo.applicationDomain, function(asset:Loader):void
						{
							done(kind, holder);
						});
				});
		}

		/** Load `file` into `domain`, make its class `name` in `holder`, then `then` the Loader. */
		private function load(holder:Sprite, file:String, name:String, domain:ApplicationDomain, then:Function):void
		{
			const loader:Loader = new Loader();
			loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					holder.addChild(loader);
					holder.addChild(new (loader.contentLoaderInfo.applicationDomain.getDefinition(name) as Class)() as DisplayObject);
					then(loader);
				});
			loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e:IOErrorEvent):void
				{
					trace("error " + e.text);
				});
			loader.load(new URLRequest(file), new LoaderContext(false, domain));
		}

		private function done(kind:String, holder:Sprite):void
		{
			addChild(holder);
			if (kind == "n")
			{
				if (_map)
				{
					unload(_map);
				}

				_map = holder;
			}
			else
			{
				_items.push(holder);
				if (_items.length > KEEP)
				{
					unload(_items.shift());
				}
			}

			_loading = false;
			trace("loaded " + _at);
		}

		private function unload(holder:Sprite):void
		{
			removeChild(holder);
			for (var i:int = 0; i < holder.numChildren; i++)
			{
				const loader:Loader = holder.getChildAt(i) as Loader;
				if (loader)
				{
					loader.unloadAndStop();
				}
			}
		}
	}
}
