package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.IOErrorEvent;
	import flash.net.URLLoader;
	import flash.net.URLRequest;

	// Traces what its embedding gave it: its parameters, by name, the stage's
	// quality, scale mode and alignment, and the file a relative URL reads,
	// which the base parameter resolves.
	public class Params extends Sprite
	{
		private var _loader:URLLoader = new URLLoader();

		public function Params()
		{
			const parameters:Object = loaderInfo.parameters;
			const names:Array = [];
			for (var key:String in parameters)
			{
				names.push(key);
			}

			names.sort();
			const pairs:Array = [];
			for (var i:int = 0; i < names.length; i++)
			{
				pairs.push(names[i] + "=" + parameters[names[i]]);
			}

			trace("params: " + pairs.join(" "));
			trace("params: quality " + stage.quality + " scaleMode " + stage.scaleMode + " align " + stage.align);
			_loader.addEventListener(Event.COMPLETE, loaded);
			_loader.addEventListener(IOErrorEvent.IO_ERROR, failed);
			_loader.load(new URLRequest("data.txt"));
		}

		private function loaded(event:Event):void
		{
			trace("params: data " + _loader.data);
		}

		private function failed(event:IOErrorEvent):void
		{
			trace("params: data failed");
		}
	}
}
