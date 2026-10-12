// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.system
{
	public function fscommand(command:String, args:String = ""):void
	{
		FSCommand._fscommand(command, args);
	}
}
