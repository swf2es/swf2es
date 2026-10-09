// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.data
{
	[API("661")]
	public class SQLColumnSchema
	{
		public function SQLColumnSchema(arg0:String, arg1:Boolean, arg2:Boolean, arg3:Boolean, arg4:String, arg5:String)
		{
		}

		public native function get allowNull():Boolean;
		public native function get autoIncrement():Boolean;
		public native function get defaultCollationType():String;
		public native function get dataType():String;
		public native function get name():String;
		public native function get primaryKey():Boolean;
	}
}
