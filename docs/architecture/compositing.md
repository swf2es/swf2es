# Colour, blends, filters and masks

## Colour transforms

A colour transform acts on what each shape, bitmap and text field draws
under it, not on a sprite's children composited first, as adl draws it:
each fill's colour, straight rather than premultiplied, is multiplied and
offset channel by channel, alpha too, and clamped to 0–255. An alpha
offset so shows a fill of alpha 0, while a bitmap's fully transparent
pixels stay transparent. A gradient's stops are transformed and its ramp
made from them. Nested transforms apply the child's first, then the
parent's: (c · m₁ + a₁) · m₂ + a₂. The renderer puts each draw's whole
transform, concatenated from the stage down, in its row, and its
programs apply it to the straight colour of each vertex or texel, so the
geometries a character's instances, a font's text and instances in step
share draw under any transform unchanged (`shared-colors`). A glyph's
colour goes into its row too. A gradient there is
transformed pixel by pixel, which clamps after the ramp where Flash clamps
its stops, so the two part only where a transformed stop is clamped.

A filtered object is the exception: adl colours the bitmap its filters
make, the glow and the shadow too, not what they are run on. Its
colour transform from the stage down, or from the filtered object it is
in, is applied by its chain's last pass to the straight colour of each
pixel the filters made, a clear one staying clear, and what is in it is
drawn as though nothing above it, itself included, were coloured. A glowing object faded to an alpha of
0.6 had its glow drawn from its faded shape, 65 off, and offsets left the
glow as it was, 139 off (`blend-filtered-alpha`). A filtered 3D object
is coloured so in its bitmap: one at an alpha of 0.6 drew its glow from
its faded shape, 77 off. Children's own colours, masks, text, bitmaps,
filtered objects in filtered objects,
filters taken off and put on, and the colours that leave one clear, are
the `filtered-colors` case. A colour that changes
draws the output it kept again in the new colour, with no filter run.

Stencil masks ignore their own and their ancestors' visibility and colour,
while retaining ancestor transforms (`scene/masks.ts`, `walkMask`).
`mask-ancestors` checks hidden, transparent and
tinted ancestors, moving them, and removing and restoring the masks against
Flash.

## Blend modes

adl composites an object with a blend mode as a layer, its children
together in the normal way, and blends that with what is below, the
stage's colour included, rather than blending each child on its own.
An explicit `layer` with children also applies its colour transform to
their combined pixels, including any graphics on the clip itself. Without
children, it colours its fills individually.
`blend-layer-fade` checks an AVM1 timeline's fading layer, and
`blend-layer-colors` checks colour and alpha offsets, adding and removing
children, mode changes and ancestor colours against AIR.

The view writes such an object as a layer of the scene list, which the
planner sizes by what is drawn in it (`@swf2es/render`'s `measure.ts`),
so a layer, a blend's or a filter's, holds what its filtered children
draw past their shapes, as adl's holds a child's glow whole
(`blend-nested`). The backend composites a layer over its rectangle
alone (`compositeLayer`, `webgl/composite.ts`): through the GPU's
blending where it computes Flash's blend (`normal`, `layer`, `add`,
`screen`), else with the composite program reading a copy of what is
below that rectangle, its result replacing it; out of a multisampled
target, the rectangle is resolved before it is copied. The formulas are
the composite program's (`packages/render/src/webgl/programs.ts`).
Multiply, screen, lighten, darken, difference, overlay and hardlight are
the separable blends of the straight colours, composited source over;
`add` adds and `subtract` takes the object from what is below, each
clamped, subtract's alpha the object's over what is below (over a
layer's clear ground adl leaves the object's alpha in black); `invert`
inverts what is below as far as the object covers it; `alpha` and
`erase` scale the layer below by the object's alpha, or by what it
leaves, only where the object has any. An `erase` or `alpha` blend
outside any layer clears what it covers of the stage, as adl does, which
the blends after it read: an opaque canvas keeps no alpha, so without
multisampling such a frame is drawn into a layer the canvas's size and
copied onto it (`stage-erase`, `blend-direct-clear`). The `blend-modes`
case draws each over two grounds against adl, and `blend-formulas` puts
each mode's formula against adl, at five alphas over five grounds,
unfiltered and through a filter. `blend-drift` moves a blend a quarter
pixel a frame at a zoom that gives no whole resolution, which must not
shake what shows through it; `blend-edges` draws blended objects past
the edge of what they are drawn over; `blend-antialias` draws nested
blends, a blurred child of a blend and blends past the stage's edges
multisampled. `blend-kept` keeps blends still, moved, recoloured, with a
child moving, over a ground changing under them, inside a filtered
sprite and with a filter of their own, and `blend-kept-antialias` the
same multisampled; `blend-outside-mask` masks a blend from outside it,
and `blend-subpixel` moves one by part of a pixel.

## Filters

A filter object keeps its values as adl converts them, in a record of its
kind's (`display/filters.ts`): blurs clamped to 0–255, NaN kept; quality and a
convolution's size whole and clamped, to 15; alphas in 255ths; colours 24
bits; strength in 256ths, to 255; an angle within a turn either way,
through radians and back; a convolution's divisor, bias and matrix, a
colour matrix and a displacement's scale as floats, the colour matrix 20
values and a hole in it 0; a gradient's stops at most 16, its colours
setting their count, its alphas filling to it with 1, its ratios making it
fewer; a number past an int's range, as x87 converts it, 0. A display
object holds records too, from its `filters` or a PlaceObject3's list (a
bevel's highlight before its shadow, as adl reads it), and gives copies
back, so `filters === filters` is false and a filter changed after it was
set changes nothing. BitmapFilter is abstract, and restricted: a script's
class extending it is refused, while one extending a filter of
playerglobal's is made.

BitmapData's `applyFilter` filters on the CPU, as adl computes
(`bitmap/filters.ts`; the blurs, glows, shadows, bevels and convolutions
in `@swf2es/native/render`, below): the source's premultiplied channels, past the
source rect too as far as the bitmap goes, filtered, and the filter's
rect of them written whole into the destination, moved to its point and
clipped; an opaque destination keeps its alpha, and refuses a glow, a
shadow, a bevel and the gradient filters with
IllegalOperationError #2077. `generateFilterRect` grows a rect each way by the passes' spread
times the blur, a blur below 1 counting as 1: Ruffle's per-quality
spreads (1.0, 2.1, 2.7, 3.1 … 7.0) as floats, halved, rounded up from a
quarter for a blur and half to even from a half for the others, as x87
rounds, which the `rect` lines of `apply-filter` pin; a shadow's, inner
too, by its offset in whole pixels (to the nearest 256th, then down) on
the side it moves to, less it on the other, never inward; a bevel's by
the offset's size both ways. At high qualities the rect is less than the
passes' reach, and cuts what they spread. A blur is a box of fractional width, its end pixels weighted by their
part, run along x and then y `quality` times, each value truncated to
8 bits. A glow's alpha is that blur of the source's alpha (of 255 less
it, for an inner one), truncated, times strength to 255 and alpha, over
or under the source as the display's are; inner, the source keeps its
alpha and the glow lies on its straight colour, the glow's colour times
that alpha in 255ths and the source's times what is left in 256ths,
truncated, premultiplied again rounding, and knocked out the glow's
alpha is times the source's, rounded; a shadow samples it from its
offset between pixels, linearly with weights in 256ths. A colour matrix
maps straight colour, rounded, the pixels about what the source has
premultiplied truncated and the rest of the rect the map of a
transparent pixel. A bevel is the source's alpha so blurred, read from
its offset on and back between pixels, as a shadow reads; their
difference times strength, to 255, times the colour's alpha, rounded, in
the highlight colour where on is more and the shadow colour where it is
less. Inner, it lies atop the source, which keeps its alpha, on its
straight colour as an inner glow does; outer,
behind it; full, over it; knocked out, alone, masked to where the source
is (inner) or is not (outer); each over another as the store draws it,
s + d × (256 − sa) / 256 truncated. Off the axes adl reads the offset
about a 256th further out, which swf2es does not find a rule for: there
a channel may be 2 off, so the `bevel` case, to the bit, keeps to the
axes, and `bevel-draw` has the angles between. A gradient glow is a
glow's alpha (from its offset back, as a shadow's) times strength, to
255, picking its colour and alpha from a 256-entry table of its stops,
built as a gradient fill's ramp; a gradient bevel's difference, times
strength, picks entry (d + 256) / 2, so where on and back agree, outside
the source too, it takes the middle. With no stops either draws nothing
but the source. Both place their layer as the bevel does, masked by
rounding, (c × m + 127) / 255; a gradient glow's rect is a shadow's, a
gradient bevel's a bevel's, and as the table may have colour at 0 they
fill it. A displacement map moves each pixel of the source rect by the
map's channels there, read unmultiplied, the map placed at the rect's
corner and its point, the one named channel less 128 times scale, in
256ths toward 0 (none named, or several, moves nothing); it reads the
source between pixels, the four corners' weights in 256ths each
truncated; past the rect as the mode says: wrapped, clamped, its own
place where the whole pixel it lands on is past it (ignore), or the
filter's colour; where the map is not, or there is none, it keeps its
own. Its rect grows by a quarter of each scale, whole, and none with no
map; `generateFilterRect` takes any filter's rect within the bitmap first,
and a displacement's result, and an inner glow's, shadow's, bevel's or
gradient filter's, within it too. adl keeps each part of a shadow's or a
bevel's offset in 256ths in an int: 2^23 − 1 or more wraps round to
−2^23 − 256 and less stops there (`shadowOffset`), so the rect reaches
−8388866, as Infinity's does; and its angle is 6.79e-9 radians off, so the
offset grows across the axes as the distance does, 4e9 at 0° reaching 30
up (fitted from 5e5 to 1e11, taken from where it comes to a 512th). An
outer shadow or gradient glow cast past the wrap writes its rect empty,
the source too; a filter rect past the buffers adl makes is refused, 2015
for an outer shadow or gradient glow (1e5 at 45°, or 8e9 at 0° as the
part across grows), 2077 for an inner bevel and 2015 for an outer or
full one, which is refused with 2077 from 2^31 / 10 pixels already; and a
distance or angle of NaN
refuses an outer shadow and is none for the rest (`filterRefusal`). Cast some 2^15 pixels left or up, adl draws
an outer shadow in pieces as its 16-bit sums wrap, which swf2es leaves.
However far the offset, the work is what the destination shows: the
alpha read from the offset is blurred where it is read, not over all the
offset spans (the `filter-distances` case). An inner filter writes its
rect as generateFilterRect gives it, the rect within the bitmap grown
and kept within it, and adl moves it by that rect's corner from the
source rect's twice: the source rect (8, 8) at (10, 10) of an inner glow
reaching 2, whose rect is (6, 6), writes at (6, 6), not (8, 8)
(`apply-filter-inner`, every inner filter from a rect inside the
source's content, past its edge and past the bitmap's, to the bit; it
wrote the grown rect where an outer filter's goes). A displacement map
writes the rect alone: adl, displacing a rect moved elsewhere, fills its grown rect from
the rect's corner, shifted, and into an opaque destination leaves alpha,
quirks swf2es does not take on. The map is read as it is when applied.
The `apply-filter` case matches adl's numbers to the bit.

A convolution grows the rect by half its matrix, rounded down, each way.
Its taps read the source's straight colour, unmultiplied as getPixel32
does, past the source rect too: only past the bitmap's edge does a tap
take the nearest edge pixel, or with `clamp` false the filter's colour.
The kernel is not flipped: tap (i, j) of a matrix x by y reads the pixel
(i − ⌊x/2⌋, j − ⌊y/2⌋) from the one it makes. The sum is divided (a
divisor of 0 counts as 1), the bias added, each channel clamped and
truncated; `preserveAlpha` keeps the source pixel's alpha, else alpha is
summed as the colours are; the colour is then premultiplied by that
alpha as setPixel32 does, or kept straight in an opaque destination.
adl takes another way for a 3 × 3 kernel of whole weights whose positive
and negative sums each stay within 127, with a divisor from 1.1 (all
weights positive) or past 2.0001 (any negative), at pixels whose taps
all lie in the bitmap: in fixed point, the integer sum times 65536 ÷
divisor, truncated, plus one, wrapped to a short, shifted down 16 bits,
the colour premultiplied truncating. The wrap makes a divisor of 1.1 to
2 turn and shrink the weights (by 2 they negate), and that way's last
tap reads the centre pixel, not the one right and down of it. Both ways
are in `bitmap/filters.ts`, and the `convolution` case matches adl's
numbers for each, to the bit. A matrix with no taps (0 by anything, the
default filter's) copies instead: as much of the source as the grown rect
is big, from the source rect's corner, to the grown rect's corner, over
an opaque destination's pixels; what lies past the source stays as it
was.

The renderer draws a display object's blur, glow, drop shadow, colour
matrix, bevel and convolution as adl does, before its blend mode: the
view works out each filter's values, padding and insets
(`scene/filters.ts`, with the rules `display/filters.ts` and
`bitmap/filters.ts` share with applyFilter), and `@swf2es/render` runs
them as passes (`filters.ts`, its shaders in `filter-shaders.ts`, run by
`webgl/filters.ts`). A blur is
a box blurX by blurY pixels wide, the pixels at its ends weighted by how
much of them it covers, run `quality` times each way and truncated to 8
bits each time, so that blur 2.5 weighs 0.3, 0.4 and 0.3, and the filter
reaches quality × blur / 2 pixels out. A glow is the object's alpha so
blurred, times strength (clamped to 1) and alpha, in its colour, drawn
behind the object, or, inner, one less that inside it over the object;
knocked out, the object is left out. A drop shadow is a glow from
distance × (cos, sin) of its angle back, and with `hideObject` drawn
alone. A bevel is the object's alpha so blurred, read at its offset on
and back, as applyFilter has it, each pixel evaluated once at its centre;
a gradient glow and a gradient bevel pick from their table, a texture
256 wide, and draw only within the filter's rect of adl's bitmap of the
object, its pixels and one more right and down. A displacement map
reads the object's pixels as applyFilter reads the source, with the map
as it was when the object's filters were set, as Flash copies it then
(reading them back gives the live map, and setting them again takes it
anew); one with no map makes no pass. In colour mode it fills half the
scale round the object with the colour, as adl draws it.
A colour matrix maps each pixel's straight colour, offsets in
255ths, transparent pixels within the object's bounds too. A convolution
filters, as applyFilter does, a bitmap of the object's pixels and one
more right and down, its edge pixels clamped or coloured past that, and
draws the rect so grown; each pixel's texels read its centre alike. One
with no taps moves the object up and left by half the other size, a
single tap there. (adl's copy then reads a row past its bitmap and draws
what memory lies there; swf2es leaves that row transparent.) Blurs and
distances are in pixels of the stage: a glow on an object scaled twice
reaches no further than on one at its size, as adl draws it, but on a
stage a host shows at three times its size it reaches three times as
many screen pixels, as Flash Player draws a stage zoomed in its window,
measured for a blur, a glow and a drop shadow at zooms of 2, 2.8 and 3
(under exactFit each axis by its own zoom, where swf2es takes the
stage's x scale). adl cannot show a stage zoomed, so the
`zoomed-filters` case is drawn at the zoom and compared with adl's frame
of the SWF built that many times larger, filters and all, which matched
Flash Player's zoomed frame. Each chain keeps the units to a stage pixel
it was made for and is scaled again when they change, though its object
was off the list then; its padding is the reach in those units. A blur's
box steps a texel of its input, blur × texels to a stage pixel wide:
stepping a stage pixel's texels instead, on a stage shown at three times
its size, it strode over texels past its padding and cut a soft shadow
off square (the `blurred-shadow` case). A
BitmapData's pixel is a screen pixel to a draw into it, rendered at its
samples a side. The object goes into its filter layer multisampled as
the target is, as a filtered caption's edges would otherwise be stepped
beside its unfiltered neighbours' smooth ones; the passes themselves
draw single-sampled ([renderer.md](../renderer.md#the-backend)).

As Flash caches a filtered object as a bitmap, an object's filters run
as one chain whose output is kept (`scene/filter-layers.ts`, `keptOutput`, `@swf2es/render`'s
`Keeps`) and drawn again until what it was run on changes: the object or anything below it, its
transform other than a move, or how much of it the screen shows (its
colour colours the output as it is drawn). Filters set again with the values they had,
as a tween writes them on each frame or a script sets them from their
own, keep the chain and its output; a displacement's map is the same only
as the same object, which setting it again takes anew (`filterPlans`). A wide blur's
passes read blur × texels to a screen pixel a pixel, over an area grown
by its reach, so their cost rises with the cube of the texels to a stage
pixel; kept, a still object costs one copy a frame. Where there are more
texels than one to a stage pixel, a blur's and a glow's or shadow's runs
go coarser (`blurShrink`), each way on its own, so that a streak 68
across and 5 down goes coarser across alone: whole times, to a texel a
stage pixel at most, the input averaged down first and the result drawn
back between texels. What bends sharply is then off by a part of a coarse texel, which a
glow's strength multiplies: a single box bends at its ends, so it
shrinks only when wide for its strength, while two boxes or more bend
smoothly, so a glow 27 wide at quality 2 runs at a texel a stage pixel
on a screen of three. Against the full runs, on a stage shown 1.5 to 3
times its size, no channel moved more than 5, and the `wide-filters`
case holds it to adl at three times; at a texel a stage pixel nothing
changes. Bevels and the gradient filters, whose difference of two reads
strength multiplies, keep every texel. A blur of none, which an
animation's placements carry by the hundred, takes no pass in its chain,
though it pads as before. A kept output moved is drawn at the new place to the
whole texel, its content where it fell within a texel when it was
filtered. adl moves its bitmap by whole pixels where swf2es moves by
whole texels, which differ only where a pixel is drawn as several samples,
as the test page draws Flash's grid: the `filter-retween` case moves by
whole pixels. One that changes frame after frame is filtered straight to
the target, with no copy kept, and a view drawn once keeps none. adl leaves
some changes undrawn: a child moved within its parent's bounds shows in
its capture where it was as well as where it is, and a mask from outside
the object that moves leaves it clipped as it was. swf2es draws the
child once, where it is now, and also keeps the output for such a mask,
unless the object's bounds change with it. A filtered layer is measured
by what is drawn in it, cut to the target, out to whole pixels, then
padded (`@swf2es/render`'s `measure.ts`), the rules the filters'
exactness was found with; where nothing is drawn in it, it draws
nothing. Filtered layers that hold only draws, masks and other such
layers, not kept, are drawn ahead of the stage, a level at a time, and
their passes in waves ([renderer.md](../renderer.md#the-backend), held
layers).

### Native CPU filters

BitmapData's convolution, blur, glow, drop shadow, bevel and gradient glow
and bevel are computed on the CPU by `@swf2es/native/render` alone: AS3's
and AVM1's `applyFilter` call the one `BitmapKernel` of their realm
(`bitmap/kernel.ts`), made at the first filter that needs it, a worker's
in its own. A trap is tried again in a new instance, and where that fails
too, nothing is written. The player works out what a destination shows
and a shadow's or a bevel's offset; the kernel's wrapper, the blocks each
reads, in tiles over a large rect, so that its scratch stays small for any
bitmap Flash allows. It takes values only within the ranges the player's
filter objects keep, and refuses others; the player brings a filter from
a SWF's tags (filterOfSwf), whose passes, blurs and strength may lie past
them, within them first: passes to 15, blurs to 0 through 255, a negative
strength none. The colour matrix runs in the module too (pixels.zig); the
displacement map stays in JS, as it may read anywhere in its rect, which
no band of rows bounds. The JS the player had is kept as the kernels'
reference in the unit tests (`tests/unit/player/bitmap/convolution-reference.ts`,
`blur-reference.ts`, `pixels-reference.ts`), which hold the kernels to it
bit for bit (`native-bitmap.test.ts`, `native-blur.test.ts`,
`native-pixels.test.ts`).

The native package depends on no other package and loads no DOM or node
types. The kernel receives numeric records and premultiplied ARGB pixels.
Only the required rectangle and convolution halo cross into Wasm; the
result is copied into an owned Uint32Array before existing clipping and
destination writing. This preserves self-filtering and notifications, and
allows later calls, memory growth or disposal without invalidating results.
Strict double arithmetic preserves coefficient order and Flash's fixed-point
3×3 convolution quirks. The module, `render`, which it shares with the
renderer's tessellator and line builder, uses wasm SIMD and has no
scalar build: every current browser ships SIMD, and an engine without it
refuses the module as one without Wasm does, where nothing plays, as
fills and lines need it. Trapped instances are dropped;
ordinary rejection can reuse scratch. Scratch has a 128 MiB absolute limit;
instances above the default 8 MiB retention threshold are dropped after a
call. Each user of `render` instantiates it apart, with its own memory and
lifetime.

## Masks and scroll rectangles

A mask clips what it masks to where its fills are, as adl draws it: the
fills alone, whole, whatever their alpha, the object's alpha and colour,
or `visible`; lines draw nothing, and a Bitmap clips to its rectangle,
transparent pixels and all. Masks nest, each clipping inside the other.
A timeline's mask is a child placed with a clip depth: it is not drawn,
and it clips the children after it in render order until one placed at a
depth beyond its clip depth. A child a script puts among them, or after
them where nothing deeper ends the range, is clipped with them. Removing
the mask ends the range. `mask` set on an object makes the
other object its mask: not drawn, wherever it is. On the display list it
clips through its own place there. Off the list it clips through its own
matrix, taken in the stage's space. One mask clips one object, so
setting it on a second takes it off the first, whose `mask` is then
null. Neither kind changes bounds or `width`, and a shape hit test
follows `mask` but not a timeline's masks; a mask, a script's or a
timeline's, is never hit by a shape test, nor is what is in it (the
`scale9-hits` case), and a Bitmap, masking or not, is hit over its whole
rectangle. The view writes each mask
into the scene list as a stencil: its drawing between a push and its
use, then what it masks, then a pop (`scene/masks.ts`, `walkMask`), a
timeline's range so clipped by its clip-depth child, and a mask's lines
left out. When both objects are cached as bitmaps Flash clips by the
mask's alpha; that, and a text field as a mask, are still to come.
What would clip a mask's own coverage (its own mask, scroll rectangle or
a field's gutter) is drawn without, and counted (`unsupported.masks`).

`scrollRect` is kept as set, its edges rounded to whole pixels half to
even, so its width and height are the rounded right and bottom less the
rounded left and top. It takes effect at the next render, as Flash's
does. From then on the object is drawn shifted by the rectangle's left
and top and clipped to it, and its bounds in its own space are the
rectangle's size at (0, 0). Its points go through the shift, in its own
`localToGlobal` and below, but its `concatenatedMatrix` leaves its own
shift out, as Flash's does, while its children's take it in. A hit
test misses outside it.
