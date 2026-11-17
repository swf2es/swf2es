package
{
	import flash.display.DisplayObject;
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.net.URLRequest;
	import flash.system.ApplicationDomain;
	import flash.system.LoaderContext;

	// Loads gear SWFs, each a symbol of a class with shapes and a bitmap, as
	// an online game loads each player's gear while they are around, and
	// lets go of them without unload(), as such a game does. By `mode`:
	// dropped, each in a Loader of its own, put on the stage and then taken
	// off and forgotten; shared, all into one application domain by a few
	// Loaders, each loading the next into itself, an instance of the gear's
	// class from the domain kept for a while; churn, each kind loaded once
	// and kept, instances of their classes made and dropped every frame.
	// Traces a line for each let go of.
	public class LeakGear extends Sprite
	{
		private static const KEEP:int = 6;
		private static const AT_ONCE:int = 4;

		private var _mode:String;
		private var _kinds:int;
		private var _frame:int = 0;
		private var _started:int = 0;
		private var _pending:int = 0;
		private var _dropped:int = 0;
		private var _alive:Array = [];
		private var _domain:ApplicationDomain = new ApplicationDomain(ApplicationDomain.currentDomain);
		private var _pool:Array = [];
		private var _loaded:int = 0;

		public function LeakGear()
		{
			var params:Object = loaderInfo.parameters;
			_mode = String(params.mode);
			_kinds = int(params.kinds);
			addEventListener(Event.ENTER_FRAME, tick);
		}

		private function tick(e:Event):void
		{
			_frame++;
			for (var i:int = _alive.length - 1; i >= 0; i--)
			{
				if (_alive[i].until <= _frame)
				{
					removeChild(_alive[i].item);
					_alive.splice(i, 1);
					_dropped++;
					trace("dropped " + _dropped);
				}
			}

			if (_mode == "churn")
			{
				churn();
				return;
			}

			while (_pending + _alive.length < AT_ONCE)
			{
				start();
			}
		}

		private function start():void
		{
			var kind:int = _started % _kinds;
			var request:URLRequest = new URLRequest("gear-" + kind + ".swf");
			_started++;
			_pending++;
			if (_mode == "shared")
			{
				var pooled:Loader = _pool.length ? _pool.pop() : pooledLoader();
				pooled.name = String(kind);
				pooled.load(request, new LoaderContext(false, _domain));
				return;
			}

			var loader:Loader = new Loader();
			loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					_pending--;
					keep(loader);
				});
			loader.load(request);
		}

		private function pooledLoader():Loader
		{
			var loader:Loader = new Loader();
			loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void
				{
					_pending--;
					keep(made(int(loader.name)));
					_pool.push(loader);
				});
			return loader;
		}

		private function churn():void
		{
			if (_loaded < _kinds)
			{
				if (_started == 0)
				{
					for (var k:int = 0; k < _kinds; k++)
					{
						var loader:Loader = new Loader();
						loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void
							{
								_loaded++;
							});
						loader.load(new URLRequest("gear-" + k + ".swf"), new LoaderContext(false, _domain));
						_pool.push(loader);
						_started++;
					}
				}

				return;
			}

			while (_alive.length < AT_ONCE)
			{
				keep(made(_started++ % _kinds));
			}
		}

		private function made(kind:int):DisplayObject
		{
			var gear:Class = _domain.getDefinition("LeakGear" + kind) as Class;
			return new gear();
		}

		private function keep(item:DisplayObject):void
		{
			item.x = _alive.length * 20;
			addChild(item);
			_alive.push({item: item, until: _frame + KEEP});
		}
	}
}
