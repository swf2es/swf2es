// How E4X writes text as XML: an element's text and an attribute's value
// escaped, as esc_xelem and esc_xattr and XML's own toXMLString write them.

const XML_ELEMENT: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\0": "&#x0;",
};

const XML_ATTRIBUTE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  '"': "&quot;",
  "\n": "&#xA;",
  "\r": "&#xD;",
  "\t": "&#x9;",
  "\0": "&#x0;",
};

/** As AvmCore::EscapeElementValue: & < > escaped, and without whitespace around it if `trim`. */
export function escapeElementValue(s: string, trim: boolean): string {
  let t = s;
  if (trim) {
    let start = 0;
    let end = s.length;
    while (end > 0 && isXMLSpace(s.charCodeAt(end - 1))) {
      end--;
    }

    while (start < end && isXMLSpace(s.charCodeAt(start))) {
      start++;
    }

    t = s.slice(start, end);
  }

  return t.replace(/[&<>\0]/g, (c) => XML_ELEMENT[c]);
}

/** As AvmCore::EscapeAttributeValue. */
export function escapeAttributeValue(s: string): string {
  return s.replace(/[&<"\n\r\t\0]/g, (c) => XML_ATTRIBUTE[c]);
}

const isXMLSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
