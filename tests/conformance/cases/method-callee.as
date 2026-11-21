// A method's arguments.callee is the method bound to its receiver, the
// closure a read of the method gives: avmplus keeps one MethodClosure for
// a method and a receiver, so arguments.callee == this.m, by a name or a
// string, for an instance's method, a class's static one and a script's
// function. An override's callee is its own, not the base method's, and a
// method applied to another receiver is bound to that one.
class CalleeBase {
	public var name:String;

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

	public static function sm():String {
		return String(arguments.callee === CalleeBase.sm);
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
}

function scriptFunction():Boolean {
	return arguments.callee === scriptFunction;
}

var a:CalleeBase = new CalleeBase("a");
var b:CalleeBase = new CalleeBase("b");
trace("method", a.m());
trace("closure", (a.m as Function)());
trace("static", CalleeBase.sm());
trace("override", new CalleeSub("s").base());
trace("same receiver", a.self() === a.self(), a.self() === a.self);
trace("other receiver", a.self() === b.self(), a.self.call(b) === a.self);
trace("script", scriptFunction());
var anon:Function = function():Boolean {
	return arguments.callee === anon;
};
trace("anonymous", anon());
