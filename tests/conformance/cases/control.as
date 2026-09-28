// Control flow: loops, switch, labels, try, catch and finally.
var out:Array = [];
for (var i:int = 0; i < 5; i++) {
  if (i == 1) continue;
  if (i == 4) break;
  out.push(i);
}
trace("for", out);
var j:int = 3;
while (j-- > 0) out.push(j);
do { out.push("d"); } while (false);
trace("while", out);
function sw(v:*):String {
  switch (v) {
    case 1: return "one";
    case "1": return "string one";
    case 2:
    case 3: return "two or three";
    default: return "other";
  }
}
trace("switch", sw(1), sw("1"), sw(3), sw(null));
function dense(v:int):String {
  switch (v) { case 0: return "a"; case 1: return "b"; case 2: return "c"; case 5: return "f"; }
  return "none";
}
trace("dense", dense(0), dense(2), dense(5), dense(-1), dense(9));
outer: for (var a:int = 0; a < 3; a++) {
  for (var b:int = 0; b < 3; b++) {
    if (b == 1) continue outer;
    if (a == 2) break outer;
    trace("label", a, b);
  }
}
function tf(n:int):String {
  var log:String = "";
  try {
    log += "try ";
    if (n == 1) throw new Error("e1");
    if (n == 2) return log + "returned";
  } catch (e:Error) {
    log += "catch " + e.message + " ";
  } finally {
    log += "finally";
  }
  return log;
}
trace("try", tf(0), "|", tf(1), "|", tf(2));
try {
  try { throw "inner"; } finally { trace("inner finally"); }
} catch (e:*) { trace("rethrown", e); }
try { throw 42; } catch (e:String) { trace("string"); } catch (e:*) { trace("any", e); }
