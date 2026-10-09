// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("661")]
	public class SQLEvent extends Event
	{
		public function SQLEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false)
		{
			super(arg0);
		}

		public static const ANALYZE:String = "analyze";
		public static const ATTACH:String = "attach";
		public static const BEGIN:String = "begin";
		public static const CANCEL:String = "cancel";
		public static const COMPACT:String = "compact";
		public static const CLOSE:String = "close";
		public static const COMMIT:String = "commit";
		public static const DEANALYZE:String = "deanalyze";
		public static const DETACH:String = "detach";
		public static const OPEN:String = "open";
		public static const REENCRYPT:String = "reencrypt";
		public static const ROLLBACK:String = "rollback";
		public static const RESULT:String = "result";
		public static const RELEASE_SAVEPOINT:String = "releaseSavepoint";
		public static const ROLLBACK_TO_SAVEPOINT:String = "rollbackToSavepoint";
		public static const SCHEMA:String = "schema";
		public static const SET_SAVEPOINT:String = "setSavepoint";
		override public native function clone():Event;
	}
}
