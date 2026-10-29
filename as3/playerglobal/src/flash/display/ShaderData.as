// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	import flash.utils.ByteArray;

	[API("662")]
	public final dynamic class ShaderData
	{
		public function ShaderData(bytecode:ByteArray)
		{
			_setByteCode(bytecode);
		}

		// The player's natives (packages/player/src/playerglobal/flash/display/ShaderData.ts).
		private native function _setByteCode(code:ByteArray):void;
	}
}
