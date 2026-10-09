// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display3D
{
	import flash.utils.ByteArray;

	[API("674")]
	public class VertexBuffer3D
	{
		public function VertexBuffer3D()
		{
		}

		public native function uploadFromVector(data:Vector.<Number>, startVertex:int, numVertices:int):void;
		public native function uploadFromByteArray(data:ByteArray, byteArrayOffset:int, startVertex:int, numVertices:int):void;
		public native function dispose():void;
	}
}
