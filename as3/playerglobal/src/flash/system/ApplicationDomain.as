// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/system/ApplicationDomain.ts.

package flash.system
{
	import flash.utils.ByteArray;

	public final class ApplicationDomain
	{
		public function ApplicationDomain(parentDomain:ApplicationDomain = null)
		{
			ctor(parentDomain);
		}

		public static native function get currentDomain():ApplicationDomain;

		[API("662", "663")]
		public static native function get MIN_DOMAIN_MEMORY_LENGTH():uint;

		public native function get parentDomain():ApplicationDomain;

		public native function getDefinition(name:String):Object;

		public native function hasDefinition(name:String):Boolean;

		public native function getQualifiedDefinitionNames():Vector.<String>;

		[API("662", "663")]
		public native function get domainMemory():ByteArray;

		[API("662", "663")]
		public native function set domainMemory(value:ByteArray):*;

		// The player's natives (packages/player/src/playerglobal/flash/system/ApplicationDomain.ts).
		private native function ctor(parentDomain:ApplicationDomain):void;
	}
}
