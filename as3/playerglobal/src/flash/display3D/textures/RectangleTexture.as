// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display3D.textures
{
	import flash.display.BitmapData;
	import flash.utils.ByteArray;

	[API("690")]
	public final class RectangleTexture extends TextureBase
	{
		public function RectangleTexture()
		{
		}

		public native function uploadFromBitmapData(source:BitmapData):void;
		public native function uploadFromByteArray(data:ByteArray, byteArrayOffset:uint):void;
	}
}
