// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.security
{
	import flash.utils.IDataInput;

	public interface IURIDereferencer
	{
		function dereference(arg0:String):IDataInput;
	}
}
