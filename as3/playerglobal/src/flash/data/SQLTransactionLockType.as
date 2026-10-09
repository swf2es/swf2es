// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.data
{
	[API("661")]
	public class SQLTransactionLockType
	{
		public function SQLTransactionLockType()
		{
		}

		public static const DEFERRED:String = "deferred";
		public static const EXCLUSIVE:String = "exclusive";
		public static const IMMEDIATE:String = "immediate";
	}
}
