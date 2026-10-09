// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.filters
{
	import flash.display.Shader;

	[API("662")]
	public class ShaderFilter extends BitmapFilter
	{
		public function ShaderFilter(shader:Shader = null)
		{
		}

		public native function get shader():Shader;
		public native function set shader(value:Shader):void;
		public native function get leftExtension():int;
		public native function set leftExtension(value:int):void;
		public native function get topExtension():int;
		public native function set topExtension(value:int):void;
		public native function get rightExtension():int;
		public native function set rightExtension(value:int):void;
		public native function get bottomExtension():int;
		public native function set bottomExtension(value:int):void;
	}
}
