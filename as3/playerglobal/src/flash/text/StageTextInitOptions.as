// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text
{
	[API("675")]
	public class StageTextInitOptions
	{
		public function StageTextInitOptions(arg0:Boolean = false)
		{
		}

		public native function set multiline(arg0:Boolean):*;
		public native function get multiline():Boolean;
	}
}
