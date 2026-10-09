// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.automation
{
	public class ActionGenerator
	{
		public function ActionGenerator()
		{
		}

		public native function generateActions(arg0:Array):void;
		public native function generateAction(arg0:AutomationAction):void;
	}
}
