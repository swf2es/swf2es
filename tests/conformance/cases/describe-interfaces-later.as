// describeType's implementsInterface of a class whose interfaces' bases
// are declared after it, file-private, as a script's classes come before
// its interfaces: every base of every interface, however deep, as `is`
// finds them (interface-inherited-later).
import avmplus.*;

class SuperClass implements SuperInterface {}
class BaseClass extends SuperClass implements FirstInterface {}

interface FirstInterface extends FirstInterfaceParent {}
interface FirstInterfaceParent extends FirstInterfaceGrandparent {}
interface FirstInterfaceGrandparent {}

interface SuperInterface extends SuperInterfaceParent {}
interface SuperInterfaceParent extends SuperInterfaceGrandparent {}
interface SuperInterfaceGrandparent {}

function implemented(c:Class):String
{
	const names:Array = [];
	for each (var x:XML in describeType(c, FLASH10_FLAGS).factory.implementsInterface)
	{
		names.push(String(x.@type).replace(/^.*::/, ""));
	}

	names.sort();
	return names.join(" ");
}

trace("BaseClass", implemented(BaseClass));
trace("SuperClass", implemented(SuperClass));
trace(new BaseClass() is SuperInterfaceGrandparent, new BaseClass() is FirstInterfaceGrandparent);
trace("BaseClass", implemented(BaseClass));
