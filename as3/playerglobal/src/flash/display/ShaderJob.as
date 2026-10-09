// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	import flash.events.EventDispatcher;

	[API("662")]
	public class ShaderJob extends EventDispatcher
	{
		public function ShaderJob(shader:Shader = null, target:Object = null, width:int = 0, height:int = 0)
		{
		}

		public native function start(waitForCompletion:Boolean = false):void;
		public native function cancel():void;
		public native function get shader():Shader;
		public native function set shader(value:Shader):void;
		public native function get target():Object;
		public native function set target(value:Object):void;
		public native function get width():int;
		public native function set width(value:int):void;
		public native function get height():int;
		public native function set height(value:int):void;
		public native function get progress():Number;
	}
}
