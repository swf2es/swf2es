// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	import flash.utils.ByteArray;

	[API("662")]
	public class Shader
	{
		public function Shader(bytecode:ByteArray = null)
		{
			// An empty ByteArray is still a kernel to read, which Flash refuses.
			if (bytecode)
			{
				this.byteCode = bytecode;
			}
		}

		public function set byteCode(code:ByteArray):void
		{
			data = new ShaderData(code);
		}

		public native function get data():ShaderData;

		public native function set data(value:ShaderData):void;

		public native function get precisionHint():String;

		public native function set precisionHint(value:String):void;
	}
}
