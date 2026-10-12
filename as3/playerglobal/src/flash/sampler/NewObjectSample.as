// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.sampler
{
	public final class NewObjectSample extends Sample
	{
		public function NewObjectSample()
		{
		}

		// Flash Player fills these in, which swf2es does not: their type's default.
		public const id:Number = NaN;
		public const type:Class = null as Class;

		public native function get object():*;

		public native function get size():Number;
	}
}
