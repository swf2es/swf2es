// avmshell: -api SWF_12
// API version SWF_12, which a Flash Player root of SWF 12 runs at: user
// code sees the names marked up to SWF_12 in Flash Player's series, not
// later ones nor AIR's, so a class overrides a member of FP_10_0 and
// declares its own named as an AIR-only or a later one without override,
// and names built from strings (in, hasOwnProperty, a late-bound name,
// Domain.getClass, describeType, JSON, sortOn) find what it sees.
import avmplus.*;
import avmshell.*;
import flash.utils.ByteArray;

// Public at run time, as a namespace of URI "" is, though ASC, which
// checks every builtin name whatever the version, takes it for another.
namespace pub = "";

class Over extends public_class
{
	override public function public_function_FP_10_0():Boolean
	{
		return false;
	}

	pub function public_function_AIR_1_0():String
	{
		return "own AIR function";
	}
}

class OwnShareable extends ByteArray
{
	pub function get shareable():String
	{
		return "own shareable";
	}
}

function probe(name:String, f:Function):void
{
	try
	{
		trace(name, f());
	}
	catch (e:Error)
	{
		trace(name, e.errorID);
	}
}

// Versioned members of builtin and shell_toplevel, by name and early bound.
const names:Array = ["public_var", "public_var_FP_10_0", "public_var_FP_10_0_32", "public_var_AIR_1_0",
		"public_function_FP_10_0", "public_getset_FP_10_0"];
var o:public_class = new public_class();
for each (var member:String in names)
{
	trace(member, member in o, o.hasOwnProperty(member), o.propertyIsEnumerable(member));
	probe("  get", function():*
		{
			return o[member];
		});
	probe("  global", function():*
		{
			return member in this ? this[member] : "absent";
		});
}

probe("early public_var_FP_10_0", function():*
	{
		return o.public_var_FP_10_0;
	});
probe("early global public_var_FP_10_0", function():*
	{
		return public_var_FP_10_0;
	});
probe("ByteArray clear", function():*
	{
		return "clear" in new ByteArray();
	});
probe("ByteArray shareable", function():*
	{
		return "shareable" in new ByteArray();
	});
probe("Number.PI", function():*
	{
		return Number["PI"];
	});
probe("class public_class_FP_10_0", function():*
	{
		return public_class_FP_10_0;
	});
probe("Domain.getClass public_class_FP_10_0", function():*
	{
		return Domain.currentDomain.getClass("avmshell.public_class_FP_10_0");
	});
probe("Domain.getClass WorkerState", function():*
	{
		return Domain.currentDomain.getClass("avmshell.WorkerState");
	});

// describeType leaves out what the code's version does not see.
const described:Array = [];
for each (var x:XML in describeType(o, FLASH10_FLAGS)..*.(name() == "variable" || name() == "accessor" ||
		name() == "method" || name() == "constant"))
{
	if (String(x.@name).indexOf("FP_10_0") >= 0 || String(x.@name).indexOf("AIR_1_0") >= 0)
	{
		described.push(x.name() + " " + x.@name);
	}
}
described.sort();
trace("describeType", described.join(", "));

// JSON, SWF_13's, is not seen before it; then it writes and reads the members it sees.
probe("JSON", function():*
	{
		const keys:Array = [];
		for (var k:String in JSON.parse(JSON.stringify(o)))
		{
			if (k.indexOf("FP_10_0") >= 0 || k.indexOf("AIR_1_0") >= 0)
			{
				keys.push(k);
			}
		}
		keys.sort();
		return keys.join(", ");
	});

// sortOn reads its field by name: a's false sorts before b's true.
const a:public_class = new public_class();
const b:public_class = new public_class();
for each (var field:String in ["public_var", "public_var_FP_10_0", "public_var_AIR_1_0"])
{
	probe("set " + field, function():*
		{
			a[field] = false;
			b[field] = true;
			return a[field];
		});
	probe("sortOn " + field, function():*
		{
			return [b, a].sortOn(field)[0] === a;
		});
}

probe("override", function():*
	{
		const base:public_class = new Over();
		return base.public_function_FP_10_0();
	});
probe("own AIR-only name", function():*
	{
		return new Over().public_function_AIR_1_0();
	});
probe("own AIR-only name, late", function():*
	{
		return Object(new Over())["public_function_AIR_1_0"]();
	});
probe("own later name", function():*
	{
		return new OwnShareable().shareable;
	});
probe("own later name, as a ByteArray", function():*
	{
		const bytes:ByteArray = new OwnShareable();
		return bytes["shareable"];
	});
