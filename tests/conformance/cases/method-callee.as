// A method's arguments.callee is the method bound to its receiver, the
// closure a read of the method gives: avmplus keeps one MethodClosure for
// a method and a receiver, so arguments.callee == this.m, by a name or a
// string, for an instance's method, an inherited one, a namespaced one, an
// accessor, a class's static one and a script's function, however it was
// called. An override's callee is its own, not the base method's, which
// super reaches, and a method applied to another receiver is still bound
// to its own. A constructor's callee calls it on its object again. The
// name is the arguments object's own and not enumerable.
namespace calleeNs = "urn:method-callee";

interface ICallee {
	function self():Function;
}

class CalleeBase implements ICallee {
	public var name:String;
	public var lastSet:String = "";

	public function CalleeBase(name:String) {
		this.name = name;
	}

	public function m(x:int = 0):String {
		var key:String = "m";
		return [arguments.callee == this.m, arguments.callee === this.m, arguments.callee === this[key], arguments.callee.length].join(",");
	}

	public function base():String {
		return String(arguments.callee === this.base);
	}

	public function self():Function {
		return arguments.callee;
	}

	public function sup():Function {
		return arguments.callee;
	}

	public function count(n:int):int {
		return n <= 0 ? 0 : 1 + arguments.callee(n - 1);
	}

	calleeNs function named():Boolean {
		return arguments.callee === this.calleeNs::named;
	}

	public function get probe():String {
		return [typeof arguments.callee, arguments.callee.length].join(",");
	}

	public function set probe(v:String):void {
		lastSet = [typeof arguments.callee, arguments.callee.length, v].join(",");
	}

	public function callStatic():Boolean {
		return sm2() === CalleeBase.sm2;
	}

	public function withActivation(x:int):Boolean {
		var inner:Function = function():int {
			return x + 1;
		};
		return arguments.callee === this.withActivation && inner() == x + 1;
	}

	public function enumeration(a:int, b:int):String {
		var keys:Array = [];
		for (var k:String in arguments) {
			keys.push(k);
		}

		var before:String = [arguments.hasOwnProperty("callee"), arguments.propertyIsEnumerable("callee"), keys.sort().join(" ")].join(",");
		var f:Function = arguments.callee;
		keys = [];
		for (var j:String in arguments) {
			keys.push(j);
		}

		return before + "|" + [f === this.enumeration, arguments.hasOwnProperty("callee"), arguments.propertyIsEnumerable("callee"), keys.sort().join(" "), "callee" in arguments].join(",");
	}

	public static function sm():String {
		return String(arguments.callee === CalleeBase.sm);
	}

	public static function sm2():Function {
		return arguments.callee;
	}
}

class CalleeSub extends CalleeBase {
	public function CalleeSub(name:String) {
		super(name);
	}

	override public function base():String {
		var fromBase:String = super.base();
		return [arguments.callee === this.base, fromBase].join(",");
	}

	override public function sup():Function {
		return arguments.callee;
	}

	override public function count(n:int):int {
		return n <= 0 ? 100 : 10 + arguments.callee(n - 1);
	}

	public function supers():String {
		return [super.sup() === super.sup, super.sup() !== this.sup, this.sup() === this.sup, super.count(3), this.count(3)].join(",");
	}
}

class CtorProbe {
	public var hits:int = 0;
	public var sameObject:Boolean = true;

	public function CtorProbe(again:Boolean) {
		hits++;
		if (again) {
			var self:CtorProbe = this;
			arguments.callee(false);
			sameObject = self === this;
		}
	}
}

function scriptFunction():Boolean {
	return arguments.callee === scriptFunction;
}

function scriptSelf():Function {
	return arguments.callee;
}

var a:CalleeBase = new CalleeBase("a");
var b:CalleeBase = new CalleeBase("b");
var p:CalleeSub = new CalleeSub("p");
trace("method", a.m());
trace("closure", (a.m as Function)());
trace("static", CalleeBase.sm());
trace("override", p.base());
trace("same receiver", a.self() === a.self(), a.self() === a.self);
trace("other receiver", a.self() === b.self(), a.self.call(b) === a.self);
var i:ICallee = a;
trace("interface", i.self() === i.self, i.self() === a.self);
trace("inherited", p.self() === p.self, p.self() !== a.self());
trace("supers", p.supers());
trace("accessors", a.probe);
a.probe = "x";
trace("setter", a.lastSet);
trace("recursion", a.count(3), p.count(3));
trace("namespaced", a.calleeNs::named());
trace("unqualified static", a.callStatic());
trace("script", scriptFunction(), scriptSelf.call(a) === scriptSelf, scriptSelf.apply(null) === scriptSelf);
var holder:Object = {f: a.self};
trace("held", holder.f() === a.self);
Object.prototype.calleeOnPrototype = b.self;
trace("prototype", ({}).calleeOnPrototype() === b.self);
delete Object.prototype.calleeOnPrototype;
trace("activation", a.withActivation(4));
trace("enumeration", a.enumeration(1, 2));
var probe:CtorProbe = new CtorProbe(true);
trace("constructor", probe.hits, probe.sameObject);
var anon:Function = function():Boolean {
	return arguments.callee === anon;
};
trace("anonymous", anon());
