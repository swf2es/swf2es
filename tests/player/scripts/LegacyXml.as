package {
  import flash.display.Sprite;
  import flash.xml.XMLDocument;
  import flash.xml.XMLNode;
  import flash.xml.XMLNodeType;

  // flash.xml's XMLDocument parsed by playerglobal over the XML tokenizer's
  // tags, and XMLNode's escaping as toString writes text.
  public class LegacyXml extends Sprite {
    public function LegacyXml() {
      var doc:XMLDocument = new XMLDocument();
      doc.ignoreWhite = true;
      doc.parseXML("<?xml version=\"1.0\"?><!DOCTYPE note><root a='1'>\n  <item id='x'>one &amp; two</item>" +
        "<empty/><![CDATA[<raw>]]><!-- note --></root>");
      trace("xmlDecl", doc.xmlDecl, "docTypeDecl", doc.docTypeDecl);
      var root:XMLNode = doc.firstChild;
      trace("root", root.nodeName, root.attributes.a, root.childNodes.length);
      for each (var child:XMLNode in root.childNodes) {
        trace("  child", child.nodeType, child.nodeName, child.nodeValue);
      }
      trace("by id", doc.idMap.x.firstChild.nodeValue);
      trace("string", doc.toString());

      var text:XMLNode = new XMLNode(XMLNodeType.TEXT_NODE, "a < b & \"c\" 'd' > e");
      trace("escaped", text.toString());

      var spaced:XMLDocument = new XMLDocument("<a> <b>x</b> </a>");
      trace("whitespace kept", spaced.firstChild.childNodes.length);

      for each (var bad:String in ["<a>", "<a></b>", "</a>", "<a b=c/>", "<!-- open", "<![CDATA[ open"]) {
        try {
          var broken:XMLDocument = new XMLDocument();
          broken.parseXML(bad);
          trace("parsed", bad, broken.toString());
        } catch (e:Error) {
          trace("rejected", bad, e.errorID);
        }
      }
    }
  }
}
