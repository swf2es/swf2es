// describeType names a member's Vector type as Vector.<T>, the int, uint,
// Number and * Vectors' too, whose classes are Vector$int and the rest.
package
{
	public class Holder
	{
		public var ints:Vector.<int>;
		public var uints:Vector.<uint>;
		public var numbers:Vector.<Number>;
		public var anys:Vector.<*>;
		public var strings:Vector.<String>;
		public var nested:Vector.<Vector.<Number>>;

		public function take(a:Vector.<int>, b:Vector.<Number> = null):Vector.<uint>
		{
			return null;
		}
	}
}
import avmplus.describeType;
import avmplus.FLASH10_FLAGS;
var x:XML = describeType(new Holder(), FLASH10_FLAGS);
// In name order: avmshell lists traits in its table's order.
var lines:Array = [];
for each (var v:XML in x.variable)
{
	lines.push(v.@name + " " + v.@type);
}
lines.sort();
trace(lines.join("\n"));
for each (var p:XML in x.method.parameter)
{
	trace(p.@index, p.@type);
}
trace(x.method.@returnType);
trace(describeType(new Vector.<int>(), FLASH10_FLAGS).@name);
