// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.sampler
{
	public final class NewObjectSample extends Sample
	{
		public function NewObjectSample()
		{
		}

		public const id:Number;
		public const type:Class;
		public native function get object():*;
		public native function get size():Number;
	}
}
