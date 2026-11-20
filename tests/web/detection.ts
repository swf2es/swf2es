// An old page's Flash detection, as swfobject 2 wrote it, for the test
// pages to run as a classic script: flashVersion() is Flash Player's
// [major, minor, revision], from navigator's plug-in or Internet
// Explorer's ActiveX control, and [0, 0, 0] where there is neither.
export const detection = `
function flashVersion() {
  var version = [0, 0, 0];
  var plugins = navigator.plugins, mimeTypes = navigator.mimeTypes;
  if (typeof plugins != "undefined" && typeof plugins["Shockwave Flash"] == "object") {
    var d = plugins["Shockwave Flash"].description;
    var mime = typeof mimeTypes != "undefined" && mimeTypes["application/x-shockwave-flash"];
    if (d && !(mime && !mime.enabledPlugin)) {
      d = d.replace(/^.*\\s+(\\S+\\s+\\S+$)/, "$1");
      version = [
        parseInt(d.replace(/^(.*)\\..*$/, "$1"), 10),
        parseInt(d.replace(/^.*\\.(.*)\\s.*$/, "$1"), 10),
        /[a-zA-Z]/.test(d) ? parseInt(d.replace(/^.*[a-zA-Z]+(.*)$/, "$1"), 10) : 0,
      ];
    }
  } else if (typeof window.ActiveXObject != "undefined") {
    try {
      var v = new ActiveXObject("ShockwaveFlash.ShockwaveFlash").GetVariable("$version");
      if (v) {
        v = v.split(" ")[1].split(",");
        version = [parseInt(v[0], 10), parseInt(v[1], 10), parseInt(v[2], 10)];
      }
    } catch (e) {}
  }
  return version;
}
`;
