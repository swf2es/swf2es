// A class implementing an interface whose own bases are declared after
// it, file-private, as a script's classes come before its interfaces: the
// class has every base of every interface, however deep, whichever of the
// interfaces it extends names them.
class SuperClass implements SuperInterface {}
class BaseClass extends SuperClass implements FirstInterface, SecondInterface {}

interface FirstInterface extends FirstInterfaceParent {}
interface FirstInterfaceParent extends FirstInterfaceGrandparent {}
interface FirstInterfaceGrandparent {}

interface SecondInterface extends FirstInterfaceParent, SecondInterfaceParent {}
interface SecondInterfaceParent extends SecondInterfaceGrandparent {}
interface SecondInterfaceGrandparent {}

interface SuperInterface extends SuperInterfaceParent, SecondInterfaceParent {}
interface SuperInterfaceParent extends SuperInterfaceGrandparent {}
interface SuperInterfaceGrandparent {}

var interfaces:Array = [FirstInterface, FirstInterfaceParent, FirstInterfaceGrandparent,
	SecondInterface, SecondInterfaceParent, SecondInterfaceGrandparent, SuperInterface,
	SuperInterfaceParent, SuperInterfaceGrandparent];
var base:BaseClass = new BaseClass();
var sup:SuperClass = new SuperClass();
for (var i:int = 0; i < interfaces.length; i++)
{
	trace(interfaces[i], base is interfaces[i], sup is interfaces[i]);
}
