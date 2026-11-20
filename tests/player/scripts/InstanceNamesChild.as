// The AS3 SWF InstanceNamesLoads loads: its root's name, and the next one made.
package
{
	import flash.display.Sprite;

	public class InstanceNamesChild extends Sprite
	{
		public function InstanceNamesChild()
		{
			trace("child " + name + " " + new Sprite().name);
		}
	}
}
