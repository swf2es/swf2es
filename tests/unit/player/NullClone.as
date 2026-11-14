package
{
	import flash.display.MovieClip;
	import flash.events.Event;
	import flash.events.EventDispatcher;
	public class Main extends MovieClip
	{
		public function Main()
		{
			const first:EventDispatcher = new EventDispatcher();
			const second:EventDispatcher = new EventDispatcher();
			first.addEventListener("custom", function(e:Event):void
				{
					try
					{
						second.dispatchEvent(e);
					}
					catch (error:TypeError)
					{
						trace(error.errorID);
					}
				});
			first.dispatchEvent(new NullClone());
		}
	}
}
import flash.events.Event;
class NullClone extends Event
{
	public function NullClone()
	{
		super("custom");
	}
	override public function clone():Event
	{
		trace("cloned");
		return null;
	}
}
