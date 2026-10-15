// The global functions in AVM1, by version (docs/avm1.md, "The global
// functions"): escape and unescape's bytes, parseInt's prefixes and
// radixes, parseFloat, isNaN, isFinite, ASnative and ASSetNative.
trace("escape " + escape("a b+c/d?e=f&g@h*i_j-k.l~m!n'o(p)q") + " " + escape("é€😋") + " " + escape() + " " + escape(5) + " " + escape(null) + " " + escape(undefined));
trace("unescape " + unescape("a%20b+c%2Bd%e9%C3%A9%u00e9%zz%2%") + " " + unescape() + " " + unescape("%E2%82%AC"));
trace("parseInt " + parseInt("42") + " " + parseInt(" 42abc") + " " + parseInt("0x1F") + " " + parseInt("-0x1F") + " " + parseInt("010") + " " + parseInt("019") + " " + parseInt("ff", 16) + " " + parseInt("z", 36) + " " + parseInt("10", 2) + " " + parseInt("10", 1) + " " + parseInt("10", 37) + " " + parseInt("") + " " + parseInt() + " " + parseInt("abc") + " " + parseInt("-") + " " + parseInt("+5") + " " + parseInt("1e3") + " " + parseInt("3.9") + " " + parseInt(null) + " " + parseInt("0x") + " " + parseInt("  -0x10") + " " + parseInt("0x  -10") + " " + parseInt("0x100", 10) + " " + parseInt("-010") + " " + parseInt("12345678901234567890"));
trace("parseFloat " + parseFloat("3.14") + " " + parseFloat(" 3.14abc") + " " + parseFloat("1e3") + " " + parseFloat(".5") + " " + parseFloat("-.5e-2x") + " " + parseFloat("abc") + " " + parseFloat("") + " " + parseFloat() + " " + parseFloat("Infinity") + " " + parseFloat("0x10") + " " + parseFloat("1e") + " " + parseFloat("+1") + " " + parseFloat("1.2.3") + " " + parseFloat("\t\n 7"));
trace("isNaN " + isNaN() + " " + isNaN(1) + " " + isNaN("x") + " " + isNaN("5") + " " + isNaN(undefined) + " " + isNaN(null) + " " + isNaN(0/0));
trace("isFinite " + isFinite() + " " + isFinite(1) + " " + isFinite(1/0) + " " + isFinite("5") + " " + isFinite("x") + " " + isFinite(null) + " " + isFinite(undefined));
trace("typeof " + typeof escape + " " + typeof trace + " " + typeof ASnative + " " + typeof ASSetNative + " " + typeof ASSetNativeAccessor + " " + typeof updateAfterEvent + " " + typeof getTimer + " " + typeof ASnew);
trace("ASnative " + typeof ASnative(100, 0) + " " + ASnative(100, 0)("a b") + " " + ASnative(200, 0)(-3) + " " + typeof ASnative(999, 0) + " " + typeof ASnative(100) + " " + (ASnative(100, 0) == escape) + " " + ASnative(252, 7).call([1, 2], "+"));
var o = {};
ASSetNative(o, 200, "abs,min,8max,6sin");
trace("ASSetNative " + typeof o.abs + " " + o.abs(-2) + " " + o.min(3, 1) + " " + o.max + " " + typeof o.sin);
var s = ""; ASSetPropFlags(o, null, 0, 1); for (var k in o) s += k + " "; trace("keys " + s);
var p = {};
ASSetNativeAccessor(p, 200, "x,y", 0);
trace("ASSetNativeAccessor " + typeof p.x + " " + p.y);
trace("updateAfterEvent " + updateAfterEvent());

// -- parseInt
function t(s, r) { trace("[" + s + "] r=" + r + " -> " + (r == undefined ? parseInt(s) : parseInt(s, r))); }
t("0x"); t("0x  -10"); t("  -0x10"); t(" 0x10"); t("+0x10"); t("-0x10", 16); t("-0x10", 34); t("0x10", 16); t("0x10", 8); t("0x1g");
t("0"); t("00"); t("08"); t("-08"); t(" 010"); t("010x"); t("0.5"); t("-0"); t("- 5"); t(" +5"); t("\t 5"); t(" 5"); t("5 6");
t("z", 36); t("Z", 36); t("10", "16"); t("10", 0); t("10", -1); t("10", 2.9); t("10", 0/0); t("1e2"); t("Infinity"); t("1".concat("0000000000000000000000"));
t(".5"); t("-.5"); t("0x-1"); t("0X1F"); t("x1"); t("12abc", 16); t("-ff", 16); t("+ff", 16);
