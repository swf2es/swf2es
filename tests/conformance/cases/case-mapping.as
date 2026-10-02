// avmplus maps case unit by unit, by Unicode tables older than JavaScript's:
// a unit to one unit only, with no final sigma, and a surrogate pair as it is.
function codes(s:String):String {
  var out:Array = [];
  for (var i:int = 0; i < s.length; i++) {
    out.push(s.charCodeAt(i));
  }
  return out.join(",");
}
trace(codes("ßµŉǰΐẖﬀ".toUpperCase()));
trace(codes("İΣႠⰀꙀẞ".toLowerCase()));
trace(codes("AΣ Σ".toLowerCase()), codes("ςᾀᾳ".toUpperCase()));
trace(codes("აɐᵹ".toUpperCase()), codes("𐐨𐐀".toUpperCase()));
trace(codes("ß".toLocaleUpperCase()), codes("İ".toLocaleLowerCase()));
trace("abcé".toUpperCase(), "ABCÉ".toLowerCase());
var words:Array = ["Ⴁ", "Ⴀ", "b", "B", "a"];
trace(codes(words.sort(Array.CASEINSENSITIVE).join("")));
