// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display3D.textures
{
	import flash.events.EventDispatcher;

	[API("674")]
	public class TextureBase extends EventDispatcher
	{
		public function TextureBase()
		{
		}

		public native function dispose():void;
	}
}
