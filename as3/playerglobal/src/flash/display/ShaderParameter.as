// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	[API("662")]
	public final dynamic class ShaderParameter
	{
		public function ShaderParameter()
		{
		}

		public native function get value():Array;

		public native function set value(value:Array):void;

		public native function get type():String;

		public native function get index():int;
	}
}
