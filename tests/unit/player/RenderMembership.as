package
{
	import flash.display.*;
	import flash.events.Event;
	public class RenderMembership extends Sprite
	{
		private var kept:Array = [];
		private var on:Sprite = new Sprite();
		private var group:Sprite = new Sprite();
		public function RenderMembership()
		{
			watch(this, "root");
			watch(stage, "stage");
			addChild(on);
			watch(on, "on");
			watch(new Sprite(), "off");
			var removed:Sprite = new Sprite();
			addChild(removed);
			removeChild(removed);
			watch(removed, "removed");
			var hidden:Sprite = new Sprite();
			hidden.visible = false;
			addChild(hidden);
			watch(hidden, "hidden");
			var child:Sprite = new Sprite();
			group.addChild(child);
			watch(child, "offChild");
			addEventListener(Event.ENTER_FRAME, function(e:Event):void
				{
					stage.invalidate();
				});
		}
		private function watch(o:DisplayObject, label:String):void
		{
			kept.push(o);
			o.addEventListener(Event.ENTER_FRAME, function(e:Event):void
				{
					trace("E:" + label);
				});
			o.addEventListener(Event.RENDER, function(e:Event):void
				{
					trace("R:" + label);
				});
		}
		public function swap():void
		{
			removeChild(on);
			addChild(group);
		}
	}
}
