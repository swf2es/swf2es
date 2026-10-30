# Bitmaps

`BitmapData` is a pixel store: a `Uint32Array` of ARGB pixels,
premultiplied by alpha as Flash keeps them, so `setPixel32` premultiplies
and `getPixel32` divides back, with the rounding Flash's does (Ruffle's
`bitmapdata_accuracy` tabulates every alpha and value; adl is the judge of
the rule); a bitmap made opaque keeps every alpha at 255, and `getPixel`
answers without the alpha. The constructor refuses a side under 1 or
past 2^31 / 20 (107,374,182 passes), and more than 536,625,144 pixels
whatever the shape (32752 by 16384 and 65513 by 8191 pass in adl, 32753
by 16384 and 65514 by 8191 not), with ArgumentError 2015, as it does an
allocation the browser refuses: Flash's old limits, 8191 a side and
16,777,215 pixels, are gone; `dispose`
empties the store, after which every read, the size included, throws
2015, and a second `dispose` is nothing. `copyPixels`
into an opaque bitmap composites source over destination whether or not
`mergeAlpha` asks, as Flash does. `fillRect`, `copyPixels`, `getPixels`
and `setPixels` (ByteArrays of ARGB words), `getVector` and
`setVector`, `clone` and `rect` work on that store, clipped to it, a
Rectangle's edges rounded to the nearest pixel and a half to the even one,
as Flash rounds them (`bitmapdata_rectangle_rounding`), each edge, x and
x + width, clamped to 2^30 - 1 either way and NaN made int's least
(`pixelEdge`): under adl an x of NaN or Infinity covers nothing, a width
of Infinity reaches the bitmap's edge, and a copy's point moves by the
clamped edge. `colorTransform` alone takes a height of NaN to the bitmap's
foot from a top past 0, the height wrapping in int arithmetic; `merge`,
`copyChannel`, `paletteMap`, `threshold` and `pixelDissolve` take a
negative size as the rect it spans back over (`spanRect`), the others as
none; `applyFilter` refuses with 2015 what adl cannot make the buffers for
(`filterRefusal`). A Point's coordinates are truncated toward 0 (the
destination, alpha and hit-test points of every operation alike, under
adl: 3.7 is 3, -1.5 is -1; NaN, or past int's range, off the bitmap). A
source rect past the source's edge is clipped and the point moved with it;
`copyPixels` in place that moves right and down by no more than its rect's
size writes the rect whole instead, and what lay left of or above the
bitmap comes out empty (`copyGaps`; adl reads an opaque bitmap's as 0,
alpha and all, and draws it black, which the store keeps as opaque black;
a transparent one's are whatever its memory held, kept transparent; the
`bitmap-rects` case).
`copyPixels`
copies in place in Flash's order, which within one store reads what it
already wrote in one direction (rows bottom-up only when the copy moves
down without moving left, columns right to left when it moves right;
`bitmapdata_copypixels_self`); `merge`, `paletteMap`, `threshold` and
`copyChannel` in place go rows down and pixels along, each pixel read as
the ones before it left it, and a colour matrix's `applyFilter` by fours
from each row's start; `pixelDissolve` in place dissolves the source
rect, wherever the point is; an alpha bitmap scales each premultiplied
channel by its alpha, 256 for 255, shifted down 8, and leaves the
destination as it was where it does not reach; compositing is
s + ((d * (256 - sa)) >> 8) a channel (`bitmapdata_copypixels_alpha_*`).
A Bitmap watches its store, held weakly by it, so a pixel set marks it for the renderer
without keeping a Bitmap taken off the display list alive,
which uploads the same texture again; `lock` and `unlock`
do nothing, as a store drawn from each frame needs no batching. A
`Bitmap` is a display object of its own kind (`BitmapObject`): its bounds
are its data's size, and the renderer draws it as a sprite whose texture
is uploaded from the pixels and again when they change, which the store
counts in a version the node compares.

The pixel operations that read and write the store alone are in
`bitmap/ops.ts`, beside the store and its premultiplied arithmetic in
`bitmap/bitmap.ts`; the loops of `noise`, `perlinNoise`, `copyChannel`,
`colorTransform`, `merge`, `paletteMap` and a colour matrix filter run in
the render module (`packages/native/src/render/pixels.zig`), a band of rows
at a time, which keeps their arithmetic. They write into the store in
place; a band that traps is made again in a new instance, and where that
fails too the bands before it stay written and the rest are left as they
were. `noise` and
`pixelDissolve`, whose pseudo-random sequences are Flash's own and fitted
to the values Ruffle's corpus recorded of it; `copyChannel`,
`colorTransform`, `merge`, `scroll`; `threshold`, `hitTest`,
`getColorBoundsRect`, `floodFill` and `histogram`. Each works on the
pixels as Flash does, premultiplied or not as its results show, and each
is checked by the corpus's traces and a case's trace under adl (the
`bitmap-ops` case). The rules fitted: `noise` is Park-Miller's minimal
standard generator (x · 16807 mod 2^31 − 1, a seed of 0 taken as 1 and
one below as −seed + 1), one draw per channel, R, G, B and then alpha on
a transparent bitmap alone, a value `low + r % (high − low + 1)`;
`colorTransform` reads a channel back as p · 255 / a floored, applies
(c · ⌊m · 256⌋ >> 8) + ⌊offset⌋, alpha alike, and writes it premultiplied
as c · (a + 1) >> 8, leaving a pixel of alpha 0 alone; `merge` is
((s · m + d · (256 − m)) >> 8) & 0xFF with the multiplier a uint and
nothing clamped; `copyChannel` from more than one channel copies 0;
`getColorBoundsRect` gives an empty rect where the one pixel found is the
origin; a point or rect `hitTest` never hits alpha 0, and it refuses
with ArgumentError 1508 a first point, or a second bitmap's, the bitmap
would reach past int's range from; `draw` moves its matrix in twips in
an int, so NaN draws at 0, and so does a move past the int's range,
Infinity too, for a matrix that only moves (one that scales draws it
nowhere), while one within 2^30 twips of the ends wraps round to near 0;
`pixelDissolve`
visits the rect, clipped to both bitmaps, in Flash's own order, a Galois
LFSR over ⌈log2 w⌉ + ⌈log2 h⌉ bits whose taps for every width from 2 to
26 bits were read off adl, a state standing for (s & (2^bw − 1), s >> bw)
and skipped outside the rect; each call writes numPixels and returns the
next state; every call writes the origin too, 0 starts at the tap, a
seed past the states steps down to them as any state does, its bits
shifted out, or to 0, which writes the origin from then on, a count of 0
or a rect a pixel wide or high gives the seed back, and a count past the
w · h − 1 states a round visits is one round and the remainder, which
gives Flash's seed without its loop (Flash itself takes seconds over
2^31 − 1). `paletteMap` makes each copied pixel the sum, wrapping at 32
bits, of its unpremultiplied channels' entries in the four tables, a
missing table its channel itself; `compare` is 0 for the same pixels,
-3 and -4 for another width and height, or a new transparent BitmapData
of each differing pixel's colour difference, opaque, or where only alpha
differs of the alpha difference in every premultiplied channel (the
`palette-compare` case). `perlinNoise` is the reference implementation of
SVG's feTurbulence, which Flash's matches to the byte (`bitmap/turbulence.ts`,
after Ruffle's port): Park-Miller seeds four channels' gradients, each
octave moved by its offset, a channel's noise drawn from the next of
the four only for the channels asked for (the set-up in TypeScript, the
noise of each pixel in pixels.zig, in the same f64 arithmetic), a byte made of it as Flash
makes it, and the pixel written as it comes, not premultiplied (the
`perlin-noise` case). A double past an int converts as on x86, to -2^31,
so that octaves enough to take the lattice that far give Flash's wild
noise and bytes of 0; more than 1024 octaves give what 1024 do, as
Flash's sum settles long before, a negative count among them. A
negative base is taken as its size, and stitching fits each frequency to
its own side, without the reference's slip of the y frequency's floor
from the x one (adl).

## Drawing into a bitmap

`draw` and `drawWithQuality` take one of two paths. A
BitmapData or a Bitmap drawn is composited on the CPU, by `drawBitmap`
in `bitmap/ops.ts`: through the matrix by the inverse of each destination
pixel's centre, nearest or bilinear as `smoothing` asks, the colour
transform as `colorTransform` applies it, then the blend mode (normal,
`alpha`, `erase`, `multiply`, `screen`, `lighten`, `darken`,
`difference`, `add`, `subtract`, `invert`), all clipped to `clipRect` and
the bitmap. Any other display object is drawn by the renderer: the
Scripting has a `drawer` the host sets once its renderer exists, before
the document class is constructed, which renders the object's subtree
through the matrix into a texture of the bitmap's size and reads it back
synchronously, as WebGL's readPixels allows, to composite as a bitmap
source is; without a renderer, as in node, drawing a display object is
not supported. The snapshot renders only the object's bounds through
the matrix, a pixel wider, within the clip and the bitmap, so its cost is
the object's size, not the bitmap's; at 4 × 4 samples a pixel averaged
down, as Flash covers edges at its high quality (`drawWithQuality` takes
1, 2 or 4 for low, medium and high), in a pass of the stage's view of
its own (`RenderView.snapshot`), which leaves the objects' dirty flags
and kept outputs to the stage's. Fills and a Bitmap's texture are the
stage's while current, so a draw of the stage builds no fill geometry;
lines are built at the draw's own scale, and the whole is rendered n
times larger, so curves are no finer than on the stage. The samples are
halved on the GPU till a sample a pixel, and only the final pixels are
read back; a snapshot is composited unscaled at a whole pixel, which
copies each pixel straight.

Each rule of a draw is Flash's
as the `draw-bitmaps` and `draw-objects` cases trace and draw it under
adl: a destination pixel takes the source pixel under its centre,
clamped to the source's edges; the translation is snapped down to
quarter pixels before rasterising, which the 4 × 4 coverage reads exactly
(a move of 0.49 covers three quarters of the left edge pixels); `normal`
is the store's source-over; a Bitmap draws as its data, its own transform
ignored, as any source's is, and its own colour transform too, though
not its filters (`filtered-colors`); a BitmapData drawn into itself goes a row
at a time, top down, every pixel of the row read before one is written,
so a move right keeps the pixels and a move down smears rows, while
through a Bitmap of itself it goes in plain scan order and smears both
ways; `alpha` and `erase` do nothing to a bitmap
drawn, which has no layer; `invert` ignores the source's colour; a fill's
alpha is a byte floored, 0.5 being 127, on the stage as in a draw. The
other blend modes follow the W3C's compositing and are judged by the
frame, within 2 a channel.

## Bitmaps on the GPU

A bitmap's pixels are the CPU's: every operation, `draw` included, which
reads its snapshot back (above), writes the store, and the renderer
uploads a store's premultiplied ARGB, as it is, into a texture of its
own when a Bitmap or a bitmap fill first shows it, and again when the
store's version has moved since (`scene/paints.ts`, `storeTexture`). Every
Bitmap showing a store samples that one texture, smoothed or not as each
asks. A texture not drawn for a while is let go of, and made again from
the store when shown again; after a lost context, every texture is
added again as it is drawn. Without a renderer, as in node, a store is
the CPU's alone.

## A SWF's bitmaps

A SWF's bitmap characters are `DefineBits` with
`JPEGTables`, `DefineBitsJPEG2`, 3 and 4, and `DefineBitsLossless` and 2.
`format` reads a tag into either pixels or an image to decode. The
lossless formats are pixels, inflated with the zlib `format` already has:
format 3 a palette of RGB, or RGBA with the 2 tag, and rows of indices
padded to 4 bytes; format 4 15-bit RGB, each 5-bit channel v widened
to v · 8 + 7 and 0 kept at 0; format 5 xRGB, or with the 2 tag ARGB
already premultiplied, which the store takes as it is. The JPEG tags are
an image: the JPEG, PNG or GIF bytes, with a JPEG's stray `FF D9 FF D8`
before its start dropped and a `DefineBits` tag's tables spliced in from
`JPEGTables`. `DefineBitsJPEG3` adds zlib'd alpha, one byte a pixel,
which goes beside the JPEG's colours as though they were premultiplied
already, so a colour above its alpha reads back as 255 (swf2es clamps it
to the alpha, which reads the same and keeps the store valid); a PNG or
GIF in it keeps its own alpha and the tag's is ignored, as Flash ignores
`DefineBitsJPEG4`'s and shows it opaque, though reported transparent. A
PNG's or GIF's alpha is premultiplied with the product floored, and the
bitmap is transparent. The player decodes the images when the SWF is
linked, beside its code, before its scripts run, through a decoder its
host may give and otherwise the browser's: WebCodecs' `ImageDecoder` for
a PNG or GIF, whose frame is copied as it is, straight alpha (its RGBA
conversion goes through premultiplied values and loses low alphas'
colours), and `createImageBitmap` through a canvas for a JPEG, which is
opaque; no JPEG library comes along. Flash's JPEG decoding matches
Chrome's to within 2 a channel at 4:4:4, but at 4:2:0 Flash's chroma is
neither repeated nor interpolated as libjpeg-turbo's is: it is smoother
than both, as IJG libjpeg 7's scaled inverse DCT upsamples it, which a
decoder that gives only pixels or planes cannot reproduce; such a JPEG
differs by some 6 a channel on average and up to 40 at sharp colour
edges, and `DefineBitsJPEG4`'s deblocking is not applied. A decoder of
swf2es's own would close both.
What Flash cannot decode is a bitmap of
0 × 0, not transparent, whose size and `rect` read and which `dispose`
takes, while every other method throws ArgumentError 2015: a corrupt
image, a `DefineBits` without `JPEGTables`, and a lossless tag written
with the short tag header, which Flash refuses whatever its data (the
long header, as Flash Pro writes, takes the same bytes). A class
SymbolClass binds to a bitmap and that extends `BitmapData` is
constructed with a copy of the pixels, the size its constructor passes
ignored (0 by 0 and −5 by 100000 alike); one that extends `Bitmap` gets
a new plain `BitmapData` of them each time. Placed on a timeline with
PlaceObject3's `HasImage`, as Flash Pro places one, a bitmap is a
`Bitmap` of its own copy, smoothing off and pixel snapping `auto`, its
data an instance of the bound class constructed with (1, 1), else a plain
`BitmapData`; without `HasImage` Flash takes the bound class for a
display object's and throws TypeError 2022, which swf2es does too.
A class SymbolClass binds to a `DefineBinaryData` and that extends
`ByteArray` starts with its bytes, at position 0; its instances share
them, each seeing what another writes until one is resized, as under adl
(the `crossbridge-runtime` case). Crossbridge keeps a C program's data
so. That case also has what Crossbridge's start asks of the player: the
domain memory on `ApplicationDomain`, the runtime's one, as avmshell's
`Domain` has it; `Worker.current`, the primordial (`isSupported` is
false, where AIR's is true, as no other worker can start); `Telemetry`,
never connected; and `System.disposeXML`, left to the collector.

## Bitmap and gradient fills

A bitmap fill is a shape's fill of type 0x40 to 0x43 or
`Graphics.beginBitmapFill`'s. Each maps the bitmap's pixels into the shape
by its matrix (a SWF's in twips, so divided by 20; `beginBitmapFill`'s in
pixels, the identity by default, repeating and not smoothed), and
`bitmap-fills` shows what Flash draws: a repeating fill tiles the bitmap,
a clipped one carries its edge pixels on beyond it, smoothed is bilinear
and not smoothed nearest, and a fill whose bitmap the SWF does not
define is solid red. A SWF's bitmap fill is resolved to its bitmap
character as the shape is read, the bitmaps being defined first, and is
drawn from one store made of the character's pixels; `beginBitmapFill`
keeps the BitmapData's store itself, so the fill shows its later changes,
the shape a view of the store as a Bitmap is. The renderer draws a fill
as geometry whose vertices carry where they sample the store's texture,
through the inverse of its matrix (`scene/shapes.ts`), each draw saying
whether it repeats or clamps and whether it is smoothed, so one texture
serves every fill of a store. Without scripts, a SWF's
images are decoded at `start` too, for its bitmap fills. A bitmap line
(`lineBitmapStyle`, a LINESTYLE2 bitmap fill) still draws its first
colour.

Gradient fills, a shape's linear, radial and focal ones and
`beginGradientFill`'s, are drawn from Flash's own ramp, which adl gives
pixel for pixel (the `gradients` case and `display/gradients.ts`'s tests): 256
colours, each channel interpolated straight between the stops and
truncated, alpha too, then premultiplied as c · (a + 1) >> 8; in linear
RGB, interpolated in sRGB's linear light, the ends through it too, which
takes 255 to 254. The stops fill the ramp in order, a span that goes
back skipped and the last colour on to the end; no stops are black. A
pixel takes entry floor(256 · t), t read at its top left corner, not its
centre; pad clamps, repeat wraps and reflect mirrors t, as a texture's
clamp, repeat and mirrored repeat do with a ramp of 256 texels. So a
linear gradient is its ramp as a texture of 256 by 1, sampled nearest,
through the gradient's matrix (a SWF's square is in twips as its shape
is, so only the translation goes to pixels) moved half a pixel for the
corner. A radial one is not affine: its texture is computed over the
bounds of what it fills, a texel a pixel up to 512 a side, each texel
the ramp's entry at its corner, so an unscaled shape's pixels are
Flash's and any spread reaches past the gradient's circle; at a focal
point off the centre Flash draws the last stop, at a centred one's
centre the first. `beginGradientFill` refuses a type but `linear` and
`radial` (ArgumentError 2008) and null colours (TypeError 2007), takes
null alphas as opaque and null ratios as even, floor(255 · k / (n − 1));
arrays of different lengths or a ratio outside 0 to 255 draw nothing,
and stops past 16 are left out. The stage's supersampling softens a hard jump
inside a fill, such as a repeating gradient's seam, which Flash leaves
hard. Gradient lines still draw their first colour.

## PNG

`encode` writes a PNG as Flash does: IHDR, one IDAT and IEND, RGBA for a
transparent bitmap and RGB for an opaque one, each colour divided out of
alpha as floor(c · 256 / a) up to 255, Flash's encoder's own rule, which
adl showed for every alpha and value and which is not `getPixel32`'s.
Only what the file decodes to is Flash's: `fastCompression` filters no
row and deflates at level 1, as Flash does; otherwise each row takes the
filter whose output sums smallest, libpng's heuristic, deflated at level
6 where Flash uses 9. A 1080p frame encodes in about 135 ms fast (Flash
about 120) and 520 ms otherwise (Flash 2.7 s), at 1% more bytes than
level 9. The rect is rounded and clipped as other methods' are, and an
empty one is ArgumentError 2006; a null rect or compressor is TypeError
2007, a compressor not an encoder's options ArgumentError 2004; the file
goes into the ByteArray given, from its position, or a new one. JPEG and
JPEG XR, which Flash also writes, are not supported yet. The
`bitmap-encode` case traces the file and each refusal under adl; fast
compression's file is Flash's byte for byte, as it is deflated
by zlib itself. `getPixels` and
`copyPixelsToByteArray` write their bytes in one pass. `setPixels` and
`copyPixelsToByteArray` honor the supplied ByteArray's `endian`;
`getPixels` creates a big-endian one with its position after the pixels.
Reads use the ByteArray's DataView without allocating per pixel, keeping
complete pixels and the read position when a later word fails with
EOFError 2030 (`bitmap-pixel-endian`).

## Pixel Bender

A `Shader` holds a `ShaderData`, which reads a Pixel Bender kernel from
its bytecode (`readPbj`, `packages/format/src/pbj.ts`) and gives a
script what adl gives it: the kernel's metadata of the first metadata
opcode (an int or a string, wherever it stands) and its name as dynamic
properties, a `ShaderParameter` for each parameter but the outputs and
`_OutCoord`, numbered in order, with its type's name, its value a copy of
its `defaultValue` (or null) and the second opcode's metadata as Arrays,
and a `ShaderInput` for each image input with its channels and texture
number. Bytes that end inside an opcode are EOFError 2030; adl refuses
much else with ArgumentError 2004, more than Ruffle's parser does: a
version other than 1, a parameter named `name`, float metadata from the
first opcode, a nop with bytes in it, an unbalanced if, and each
operation's register kinds and sizes against a table measured
opcode by opcode (`PBJ_RULES`); it takes high registers, an int sampling
coordinate and a texture never declared, which is error 2167 when the
job starts.

`ShaderJob` runs the kernel on the CPU (`bitmap/pixel-bender.ts`), as
Flash ran Pixel Bender for a job: float registers in float32, ints in
int32, every register zero at each pixel's start but the parameters and
`_OutCoord`, the pixel's centre. Each operation does what adl does,
measured on every opcode in a Vector.<Number> target and matched
exactly: ftoi rounds to the nearest even and gives int's least past its
range, a loaded int keeps 16 bits, comparisons write `i0` whatever their
destination, `equal` and `notEqual` compare scalars alone (of vectors they
are false and true), the logical operations are bitwise, `boolToFloat`
gives the bits of the int 1, `select` takes its first source on exactly
1 where `if` takes any int but 0, dot, distance and length write their
destination's first lane, and min and max return the source for NaN, as
SSE does. A BitmapData samples as its premultiplied bytes times the float
nearest 1/255, its edges clamped; linearly, each axis' weight is rounded
to 256ths, a row and then a column cut to a byte each step; floats
sample with the same weights. Into a BitmapData, which is written whole
whatever the job's size, each float is clamped, times 255 and rounded to
the nearest even, the colours kept to at most the alpha and taken as
premultiplied; three channels are opaque. A ByteArray is rewritten from
0 in its endian, and a Vector.<Number> replaced, to the job's width and
height. A parameter is the `ShaderParameter` of its name where one of its
type is there, else its default; each of its numbers must be a number
(ArgumentError 2004), and an int converts as SSE truncates. A job runs
once (2172 after); asynchronously, it computes at `start` and its
target and `ShaderEvent.COMPLETE` wait for the frame's EXIT_FRAME, as in
adl. adl runs those jobs on one thread and drops a job started beside
another, or the result of one a synchronous job follows; each job here
completes. The `shader-jobs` case draws kernels of each kind against
Flash, and Ruffle's corpus's Pixel Bender tests check the rest.

Where Flash draws with a kernel, the renderer runs it on the GPU: the
player writes it as GLSL ES 3.00 (`scene/pixel-bender-glsl.ts`), a
function `pbKernel(outCoord)` of the interpreter's operations a lane at a
time and in its order, so that a destination its source overlaps reads
the lanes written before, with its quirks (comparisons into `i0`, equal
of scalars alone, ftoi half to even, written out as not every driver
rounds so, select on exactly 1, bitwise logic, JavaScript's pow, atan2 of
-0), its parameters' registers as uniforms. `@swf2es/render`'s
`kernel-shaders.ts` puts it in a program for its use and samples its
images as the interpreter does: bytes times the float nearest 1/255,
linearly in 256ths each step cut to a byte. The pixel's coordinate is
taken from the fragment's centre, as an interpolated one lands a hair off
the half that ftoi rounds. `tests/player/pixel-bender.ts` runs families
of operations and random programs both ways on a random image, the
interpreter the reference: bytes within 2 but where a value lands across
a floor or a comparison, at most one pixel in 200 (none of 48 kernels
passes 5 pixels in 1920, in software GL or on an AMD GPU).

A `ShaderFilter` takes its Shader, which must hold a kernel (2171 as it
is set, TypeError 2007 for null), and four extensions, ints, a negative
one RangeError 2006; Flash Player's playerglobal reaches them through a
private rectangle, `_extendBy`, which the natives give too. A display
object's `filters` refuse a kernel of no inputs (2167), of an output not
four channels (2162), and of an input past the first unset (2164) or a
disposed BitmapData (2015), and take its parameters and images as they
are then, which it draws with until they are set again, as adl does. The
kernel runs over Flash's bitmap of the object, of whole stage pixels
whatever the stage's scale: those its edges touch, and one more right and
down where an edge lies on one, antialiased; those whose centres it
covers at low quality; the bounds out to twips first (`SceneList.wholes`,
`wholeBitmap`). The bitmap's corner is kept uncut (`SceneList.objects`),
so that an object hanging off the stage keeps its coordinates. Its
coordinate is the pixel's centre from the bitmap's corner in stage
pixels, whatever the object's scale or turn; its first input is the
bitmap, transparent past it and past the layer's frame, and the others
clamp to their edges, floats (a Vector or a ByteArray) as float textures,
sampled as the interpreter samples them; it writes the bitmap grown by
the extensions, transparent outside, clamped and each colour at most its
alpha. A filter before it grows what it reads, one after runs on what it
made. Where a whole number of the layer's texels make a stage pixel and
the bitmap's corner is on a texel, the layer is shrunk to one a pixel on
the bitmap's grid, the mean of the texels within the frame, the kernel
run once a pixel and drawn back, as Flash runs it over its bitmap; else
it runs at each texel. A kernel the GPU will not compile, of more than 8
images, or with an image gone, leaves its input as it was, decided as the
chain is planned. Its parameters' ints stay ints all the way, and the
programs of the backend's kernels share one cache (`webgl/kernels.ts`),
their images on units of their own. A shader's BitmapData, Vector and
ByteArray inputs are copied once for each version (a store's version, or
a hash of the numbers) and shared by the uses that take them, kept while
one holds them.

`BitmapData.applyFilter` runs the interpreter (`shaderFilter`), as adl
does, oddly: the first input is the whole source, transparent past its
edges, the coordinate is the destination's pixel's less the left and top
extensions, whatever the rect and point, and what it writes is the
source's size grown by the extensions, from the point less twice the
rect's corner (rounded) and the left and top extensions, clipped.
`generateFilterRect` gives the bitmap's own rect grown by the
extensions, whatever the rect. An opaque destination stays opaque, where
adl keeps the kernel's alpha in its store. The `shader-filters` case
draws each of these against adl. `blendShader` and shader fills are still
to come.
