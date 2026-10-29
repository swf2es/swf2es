# Text

A `TextField` is a display object of its own kind (`TextObject`), placed
by a timeline's DefineEditText or made by a script, 100 by 100 pixels and
empty, as adl makes one. Its text is a `TextModel` (`text/text.ts`): the
characters, `\r` between lines as Flash keeps them (`\n` is made one),
each with its own format, and a default format, Flash's Times New Roman
12 for a new field and the tag's for a timeline's (its font's name from
the DefineFont2 or 3 it names, its height, colour, alignment, margins,
indent and leading; the indent is signed, as Flash reads it, though the
specification has it unsigned). `text` and `htmlText` set the text in
the default format; `appendText` and `replaceText` put theirs in the
format of the character before; `getTextFormat` of a range gives null
for what its characters differ in, and `setTextFormat` sets what a
TextFormat sets.
`htmlText` is written as adl writes it: a `P` for each paragraph (an
`LI` alone for a bullet's), in a `TEXTFORMAT` for its margins, indent,
leading or tab stops, with a `FONT` of all five font attributes and,
for each later run, a `FONT` inside it of what changed; `A`, `B`, `I`
and `U` about a run's text, in that order out to in. It is read as adl
reads it, a paragraph's end and a `BR` a line only in a multiline field.
A TextFormat keeps each value as Flash converts it, null for one it does
not set: whole numbers rounded, a half away from zero, NaN and the
infinities -2147483648 as x86 converts them, `align` one of Flash's or
ArgumentError 2008, an unknown `display` null. The `text-fields` case
traces all of this, defaults, HTML and refusals, against adl.
An `IMG` is dropped, as adl drops it, by class name or URL, and
`getImageReference` gives null for every id (`text-field-queries`).
`TextField.isFontCompatible` asks the fonts `enumerateFonts` lists, the
SWF's own before any is registered: the name in any case, no CFF font,
and the style "bold", "italic" or "boldItalic" as written, any other
regular.
`getTextRuns` cuts a range where the format changes; a paragraph's line
end takes the paragraph's format; `getFirstCharInParagraph` and
`getParagraphLength` count the text's length as in the last paragraph,
one past its end.

A StyleSheet is playerglobal's own code over a few natives: its CSS is
read as Flash reads it (`text/css.ts`, Ruffle's CssStream: selectors
lower-cased, property names camel-cased, and on any of the few errors
Flash finds the whole sheet ignored), a colour is `#` and at most six hex
digits or 0, and the generic font families are Flash's device fonts. A
field with a sheet reads `text` as HTML too, refuses `replaceText` and
`replaceSelectedText` with #2009, gives `htmlText` back as it
was set, and does not read the same HTML again; each tag takes its tag's
style, a link `a:link`'s, then its class's. A tag of the sheet's own is a
block, ending its line when closed by its name, unless its style makes it
inline, and one displayed as none hides what it holds; the display is no
character's format. A change to the sheet styles the HTML again only in
a field that had HTML when the sheet was set on it, as adl does
(`text-natives`, the corpus's `stylesheet` and `edittext_stylesheet`).

Setting a TextField's `width` or `height` resizes its field, as Flash
does, not its scale. The renderer draws the background, the border over
the pixels at both edges, then the text as its layout (below) places it,
from the line scrolled to and no line that fits only part of the way,
clipped inside the gutter: a character of an embedded font as its glyph's
fill, a shape made once for the glyph and shared by every character
drawn in it, scaled to its size, tinted its colour, and moved by its
pair's kerning (its boundaries stay); a run of a device font in one
format as one item on the line's baseline (`scene/text.ts`), which a
canvas rasterizes white and its row colours. A device font
(`_sans`, `_serif`, `_typewriter`) is the browser's of that kind, any
other by its name. Bullets, underlines, input and selection are still
to come.

A field whose `antiAliasType` is advanced has its embedded glyphs drawn
as Flash's Saffron draws them (`scene/advanced.ts`, `text/saffron.ts`
and the renderer's glyph program), all of a field's as one geometry of
quads, measured in adl with fonts of bars
(`text-advanced`, `text-advanced-draw`). Each of Flash's pixels is
covered by a ramp over its signed distance to the glyph's outline, from
0 at an outside cutoff to 1 at an inside one: the shader finds the
distance exactly, from the outline cut into fine chords in a texture
every glyph shares, kept as a glyph is first drawn. The cutoffs come from
a table by size in pixels on the screen (`text/csm.ts`, measured in adl),
one for each of the font's CSM hints (its DefineFontAlignZones; none is
thin) and for light and dark text, light being a luma of 30:59:11 over
200 of the colour as drawn, under the object's colour transform: thin
light text at 20 pixels gains 0.6 of a pixel of ink across a stem, dark
0.1. `thickness` moves both cutoffs and `sharpness` each the other way, a
fiftieth of a pixel per pixel of size at the end of their ranges;
`TextRenderer.setAdvancedAntiAliasingTable` gives a font a table of its
own, for light and dark text alike, as adl uses it. A glyph lies where
adl puts it: the field's origin on the screen at a whole pixel, the pen
(in fractions of a twip) at a quarter of a pixel across and down under
`gridFitType` none, an eighth across and a whole pixel down under pixel,
a quarter across and a whole pixel down under subpixel, ties to even, and
sampled half a pixel left of the pixel's centre; turned or skewed, where
it falls. The grid is the stage's, inside a filter's input too, and a
BitmapData's in a draw. What the shader
goes through is bounded: a glyph of more than 2048 segments, or a field
whose glyphs' segments times their quads' pixels pass 2^25, is drawn as
normal text, all of the field alike, as advanced text is in a 3D
object's bitmap. The store of
segments, 16 MB at most, starts again when full, drawing again the texts
drawn from it, uploads only the rows added since, and goes with the last
view that draws on a stage. Fitting stems to
pixels by a font's alignment zones is still to come. Static text whose
CSMTextSettings ask for advanced anti-aliasing is drawn so too, though
adl drew none of the test SWF's static text with the tag after its
DefineText at all.

A field's text is laid out by swf2es, as Flash lays it out, never by the
browser: lines, and each character's place on them, are what
`textWidth`, `textHeight`, the line and character queries and
`autoSize` report, and what the renderer draws. A font embedded with
`embedFonts` is a DefineFont2 or DefineFont3, found by name, its own
size and its advances, kerning, ascent and descent from the tag, so its
layout is Flash's to the twip. adl, with fonts of rectangles built by
the tests' SWF writer, sets the rules. A character's advance is its
glyph's at the format's size, which is a whole number, truncated to
twips, plus `letterSpacing`. A kerning pair, with `kerning` on, shortens
the second character's advance. A character the font lacks takes no
room and has no boundaries; a font's characters are found by a binary
search of its code table. A line is as tall as its tallest run's ascent
and descent, each truncated to twips, plus the format's `leading` (not
the font's); its width counts its trailing spaces. Lines break at a
newline, and with `wordWrap` before a word that does not fit without
its trailing space (one ending at the room's edge fits), or between
characters for a word longer than the line. A line starts 2 pixels in,
the gutter, then the margin, block indent and, on a paragraph's first
line, its indent, and a bullet's 36 pixels; a negative indent, a hanging
one, takes the first line left as far as the gutter but gives it no
more room (`text-indent`); centred, it is placed in the room left,
right-aligned one twip further left, and justified, a wrapped line but
the paragraph's last has its inner spaces share the room. `textHeight`
is the lines' heights, leading and all, less the last one's leading
where there are two lines or more; a last line left empty by a newline
counts only while the field's type is input, whether a timeline placed
it or a script made it, and a change of type lays it out again
(`text-final-newline`). adl's `numLines` can lag a relayout until the
next one, which swf2es's does not; tab stops, the boundaries adl leaves out for lines beyond the
field's height, and those of a timeline's field, which adl gives 2
pixels further right and down than its lines, are still to come.
`autoSize` makes the field the text's size and 4 pixels, keeping its
left, centre or right edge. A device font's metrics are the browser's
font's, measured by the host, which Flash's own system fonts differ
from.

Static text (DefineText, DefineText2) is a `StaticText`: its records'
glyphs where the authoring tool put them, each record keeping the font,
height, colour and pen of the one before (`text/static.ts`), drawn with
the glyph fills a field's embedded text shares, under the tag's matrix.
A text that sets no colour draws nothing, as adl draws it. A font is
found as the text is shown, as Flash finds it, so one the SWF defines
after the text still draws it (`static-text`); a glyph of a font the SWF
lacks, or past its font's glyphs, draws nothing and moves no pen.
DefineFont's older 1024-unit outlines draw through the same glyph path as
DefineFont2 and DefineFont3. Its separate DefineFontInfo or DefineFontInfo2
supplies the name, style and character codes; the outlines draw without
that metadata too (`legacy-static-text`). A device font's text, whose
glyphs have no outlines, draws nothing where Flash draws it in a system font.
`text` is the glyphs' characters, a line feed before a record's first
where its line is not the last glyph's, and null where any glyph has no
font or character mapping, or there are none (`static-text-probe`,
`legacy-static-text-probe`, the corpus's `statictext_text`; adl reads a glyph past its font as another
character). Only a timeline makes one: a script's `new` is
refused, #2012. It is hit by its glyphs' outlines, a transparent one not at all,
and without the shape flag over its tag's rectangle; it is no
InteractiveObject, so the mouse finds its parent there. adl clips a
filtered one to its bounds, as it caches it as a bitmap of them; the
player does not, which only shows for a glyph past them.
