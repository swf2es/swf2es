// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display3D
{
	import flash.utils.ByteArray;

	[API("674")]
	public final class Program3D
	{
		public function Program3D()
		{
		}

		public native function upload(vertexProgram:ByteArray, fragmentProgram:ByteArray):void;
		public native function dispose():void;
	}
}
