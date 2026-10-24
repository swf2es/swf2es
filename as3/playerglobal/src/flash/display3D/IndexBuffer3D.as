// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display3D
{
	import flash.utils.ByteArray;

	[API("674")]
	public final class IndexBuffer3D
	{
		public function IndexBuffer3D()
		{
			Error.throwError(ArgumentError, 2012, "IndexBuffer3D");
		}

		public native function uploadFromVector(data:Vector.<uint>, startOffset:int, count:int):void;

		public native function uploadFromByteArray(data:ByteArray, byteArrayOffset:int, startOffset:int, count:int):void;

		public native function dispose():void;
	}
}
