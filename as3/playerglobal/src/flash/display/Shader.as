// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	import flash.utils.ByteArray;

	[API("662")]
	public class Shader
	{
		public function Shader(bytecode:ByteArray = null)
		{
		}

		public native function set byteCode(code:ByteArray):void;
		public native function get data():ShaderData;
		public native function set data(value:ShaderData):void;
		public native function get precisionHint():String;
		public native function set precisionHint(value:String):void;
	}
}
