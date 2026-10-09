// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	[API("662")]
	public final dynamic class ShaderInput
	{
		public function ShaderInput()
		{
		}

		public native function get input():Object;

		public native function set input(value:Object):void;

		public native function get width():int;

		public native function set width(value:int):void;

		public native function get height():int;

		public native function set height(value:int):void;

		public native function get channels():int;

		public native function get index():int;
	}
}
