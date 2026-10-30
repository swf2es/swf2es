# Rendering and geometry

## Rendering

The player draws with the renderer of swf2es's own, `@swf2es/render`,
whose design is in [renderer.md](../renderer.md). `RenderView`
(`scene/view.ts`) walks the display list each frame into a scene list,
its draws' transforms and colour transforms into rows, and has the
planner and the WebGL 2 backend draw it. What follows is what the view
works out from Flash's shapes; the layers, passes and draw calls are the
renderer's.

A shape layer's fills are geometries of the renderer's, made once for
the layer and shared by every instance that draws it (`scene/parts.ts`,
`partsOf`), a
drawing's for each version of it, and let go of once undrawn for 300
frames (`IDLE_FRAMES`). They are built from Flash's edges
(`display/shapes.ts`: each edge goes to its right fill forward and its
left fill reversed, joined into contours; one with the same fill on both
sides, a seam Flash Pro leaves inside a fill, goes to neither, so it
cannot change the winding, `shared-fill-edges`) and tessellated by
`@swf2es/native`'s libtess2, a layer in one call (`scene/fills.ts`,
`resolveFills`; [packages/native](../../packages/native/README.md)), which
flattens their curves too. What libtess2 refuses or fails at, the module
fills itself by bands: each horizontal band between vertices and
crossings filled as disjoint trapezoids under its winding rule
(`bands.zig`). The module is required: there is no JS path for fills,
lines or BitmapData's convolution. No overlapping paint is needed, including for translucent fills,
gradients, bitmaps and masks (`crossing-fills`, `crossing-cones`). A
Graphics drawing used as a stencil mask fills non-zero regardless of
`drawPath`'s winding, while static shapes keep their authored winding
(`static-mask-winding`); its mask's geometry is made apart.

A drawing redrawn every frame, as a software 3D engine draws its
triangles a fill each, is kept from piling up layers. Its new version
releases the parts of the layers its last version drew and this one no
longer does (`scene/parts.ts`), rather than leaving them for their idle
frames. A `beginFill` while the drawing's last layer holds fills alone
carries on in that layer, up to 256 fills (`display/drawing.ts`,
`SHARED_FILLS`), which draw in their order as they would in layers of
their own; a layer with lines, triangles or meshes still ends where it
is, so that its lines stay over the fills before them. Adjacent fills of
one bitmap, sampled alike, make one geometry, each vertex's texels by
its own fill's matrix. And the module fills a single convex contour as a
fan, with no sweep: convex when every turn goes the same way and its
edges reverse along each axis at most twice, so a pentagram still goes
to libtess2.

Lines (`scene/strokes.ts`) are stroked in the stage's axes, because
Flash strokes a transformed line with one width all along, not the local
width stretched by the transform: so a line's geometry depends on the
linear part of its transform on the stage, and is kept by layer and that
transform (`scene/lines.ts`), shared by every instance that sees the
layer alike (a crowd of one creature in step) and found again when one
comes back to it (a loop's next turn). A transform is a turn or a mirror
times a symmetric stretch, and a line scaled both ways is as wide
through any turn of it: such a layer's lines are stroked through the
stretch alone and turned by their row, so a limb that turns on every
frame, or a squashed particle that spins, shares one geometry through
every angle. The stretch is then settled on a grid of its logarithm, in
a step of at most 1/64 and fine enough that the lines' edges stand
within a fiftieth of a screen pixel of their place
(`display/stretch.ts`, `settledStretch`): stroked through the grid's
stretch and taken back by its inverse, the lines follow the path
exactly, and only their width sees the difference. A character that
breathes, scaling a percent or two on every frame, otherwise had a
stretch for each frame of each loop. One with a line scaled one way
alone, which turns with it, or a transform near collapse, which rounding
would distort, keeps the transform exactly. Kept lines are held within a
budget of a million vertices for those not drawn lately
(`LINE_VERTICES`). A line drawn at whole alpha, where an overlap shows
nothing, is triangles along its path; any other is outlined and filled
non-zero, so that where it overlaps itself it is drawn once. No line is
thinner than a pixel of the screen, which is how wide Flash draws a
hairline however far its stage is zoomed: `RenderView.screenScale`
screen pixels to a stage pixel, the view's scale and resolution unless
the host says otherwise, as the test page, drawing finer to average down,
does. A host showing the stage at three times its size so draws thin
outlines a screen pixel wide, as Flash does, not three.

Shapes are shared across SWFs too: a DefineShape tag whose bytes another
SWF defined alike gives that SWF's shape, held weakly, so a crowd whose
members each load the same SWF draws with one set of fills and lines, not
one per load. A shape filled with a bitmap keeps to its own SWF, whose
bitmap it is. A shape is drawn into its layers when first asked for, not
as its SWF is read: of the 17,000 shapes a large application had loaded
after ten minutes, 14,000 had no instance, and their layers, 191 MB of
the 222 MB all held, were never used. The tag is read once as the SWF
is, for the bounds and the bitmaps its fills take as the SWF has them
then, and again when it is first drawn; the SWF's bytes, which its
sounds and placements keep, are there to read it from.
A morph shape (DefineMorphShape, DefineMorphShape2) is two shapes whose
edges pair in order; a `MorphShape` shows their blend at the ratio its
placements give (`display/morph.ts`), a shape like any other, so it draws,
bounds and hit-tests as one. The blend mixes where the ends' points lie,
not their deltas, a straight edge paired with a curve as a curve, and
keeps them to whole twips, so a closed path stays closed for `display/shapes.ts`
to join. A morph keeps only its 64 latest blends, which instances in step
share, and which a looping tween finds again on its next turn: with 16, a
tween of 37 frames made each anew on every turn, its fills tessellated
again. Flash takes a new ratio on only as it draws: a script that moves
the timeline and asks for bounds before the next render gets the last
drawn blend's (`morph-shapes`, the corpus's `hittest_morph`). Only a
timeline makes a `MorphShape`; a script's `new` is refused, #2012.

Flash anti-aliases by supersampling on a grid: none at low quality, 2×2 at
medium, 4×4 at high and best. The test page draws the same way, at that
many times the resolution without multisampling, averaged down, and its
frames then match Flash's to the pixel for straight edges, and within a
quarter pixel's anti-aliasing for curved lines and lines under a skew.
A case may give a zoom, as a host showing the stage larger does: the
page's resolution is then the zoom times the grid, and the stage is drawn
at the zoom's inverse, so the samples are the same and only the
renderer's arithmetic at that resolution, no whole number, differs.
Or it may have the stage shown at the zoom, as a game's page does, its
frames the zoom's size; Flash, which cannot, then draws a SWF the case
builds at that size.

## Drawing with Graphics

A `Shape` or `Sprite` draws with its `Graphics`, which records into a
drawing the display object keeps: the same layers of fills and strokes,
with their paths in pixels, that `display/shapes.ts` makes of a SWF shape, so
the renderer draws both alike. A fill begins at `beginFill` (or a
gradient or bitmap fill) and ends at `endFill` or at the next begin, not
at a change of `lineStyle`; what is drawn between is the fill's contours, each
`moveTo` starting one and each closed back to its start, filled even-odd
across them, as Flash fills. A contour left open is closed with a line
in the line style of the time, wherever it ends (`endFill`, the next
fill, a `moveTo`, or no end at all), and with none if there is no line
style then. The pen stays where it was, and a line or curve drawn on from
it after `endFill` takes the closing line away again, where a move, a line
style or a fill keeps it. A contour along one straight line has none, as
it would only retrace it, nor does a contour `drawPath` drew, which also
begins a contour of its own at the pen. The closing line is kept beside
the stroke's paths, drawn joined to the path it ends, and left out of the
bounds and hit tests, as in adl (the `line-close` and `line-close-probes`
cases). Where a half-transparent path meets itself, at a closed path's
start or a line back over itself, the page draws it darker and adl does
not; and adl fills a `drawPath` contour left open without closing it, in
bands to the shape's edge, where the page closes it: limits noted. A stroke begins at `lineStyle` with a
thickness and ends at one without, keeping the line's width, color,
caps, joints, miter and scale mode. `drawRect`, `drawRoundRect` and
`drawRoundRectComplex` are moves and lines with quadratic quarter
circles, as Flash's; `drawCircle` and `drawEllipse` are playerglobal's
own, over `curveTo`. `cubicCurveTo` adds a cubic command to the path
model; `drawPath` takes commands and data with a winding, which is that
path's: even-odd fills by the parity of the contours around a point,
non-zero by the sum of their orientations, so a square drawn inside
another the same way round is filled under non-zero and a hole under
even-odd, and one fill drawn with both rules in turn keeps each path's,
as Flash does (the `draws` case). Crossing contours and self-intersections
use the same rules through the renderer's disjoint spans, so even-odd
leaves an overlap empty while non-zero can fill it (`crossing-fills`).
`clear` takes everything and the styles away; `copyFrom` clears first
and then copies, so a drawing copied from itself ends empty, as Flash's
does (the `draws` case). The drawn order is the calls' order but for
lines, which draw over the fill they are drawn with: a fill begun after
lines, triangles or meshes begins a layer, as a SWF shape's new styles
do, and the lines drawn from then until the next fill begins go in it,
over the fill and under the next, whenever their `lineStyle` was set; a
line open as a fill begins goes on in the new layer, and lines drawn
before any fill are a layer of their own (the `line-order` case). A fill
begun while the last layer holds fills alone goes on in it, after them,
as fills in a layer draw in order: a drawing redrawn every frame a fill
a triangle, as a software 3D engine draws, is one layer, not thousands.
A sprite's drawing is under its children.

A layer's fills are its geometries in order: a stretch of solid fills
one, and a stretch of bitmap fills of one bitmap, smoothed and repeated
alike, one, each vertex sampling through its own fill's matrix
(`scene/shapes.ts`); any other fill between them parts them. A gradient
fill is one of its own.

The renderer keeps a drawing's fills and strokes as it keeps a shape's,
per display object rather than per character, since a drawing changes,
rebuilt when the object's content changes; strokes go through the same
re-stroking as a shape's for their width under a transform. The drawing's
points, and its lines' half widths, give the object its bounds, for
`width`, `height`, `getBounds` and the hit tests to come. Gradient and
bitmap fills are recorded as a shape's are, and drawn as far as a shape's
are (the first stop); shader fills by their kernel ([bitmaps](bitmaps.md#pixel-bender)). An adl case draws in a `Shape` and in a
`Sprite` with a child, compared by pixels; the corpus's `graphics_*`
tests, which trace nothing, check that nothing throws.

`drawTriangles` draws as adl does (`display/drawing.ts`, the
`draw-triangles` case). Its triangles, three vertices each by the indices
or in order up to the first index past the vertices, go in a layer of
their own: each a fill of its own, so overlapping triangles never cancel
whichever way round they are, and the line, if one is set, around each,
its outline closed and joined, over them all. They end the open fill's
contour, whose closing line stays, and the line's path; both go on from
the pen, which stays where it was, in a layer after them, the contour
still closing to where it began. `culling` drops the triangles that turn
one way, `positive` those clockwise on the y-down screen: as they turn on
the screen, or in a BitmapData's draw, for what is drawn and the hit
tests, so a mirror drops the others (the layer's `mirrored` parts, which
`facing` puts in its place where the object's transform turns it over);
as they turn in the drawing's own space for `readGraphicsData`; and in a
3D object's own space within it, as its content is drawn into its bitmap
(the `draw-triangles-culling` case). A bitmap fill without `uvtData` fills through its matrix, as any
fill does. With `uvtData`, two or three numbers a vertex, only a bitmap
fill draws, the triangles textured and its matrix ignored; any other fill
draws nothing, nor its lines, though without a fill the lines draw. The
textured triangles are a layer's `meshes`, drawn after its fills by the
renderer's mesh program (`scene/shapes.ts`, `@swf2es/render`'s `MESH`):
u·t, v·t and t a vertex, which the GPU interpolates straight and each
pixel divides, so t is a perspective. adl maps u and v from 0 to 1 onto the bitmap's first texel's centre to
its last's, wrapped there when the fill repeats
or clamped, a hair nearer 0 as its fixed-point steps come out, and
samples once a pixel at the pixel's top left corner: the nearer texel,
or the four around weighed when smoothed; a bitmap a texel high shows its
first texel throughout. The shader reads the texels itself, so the
texture's sampling counts for nothing, and every sample of a pixel the
page draws finer takes the pixel's value. Flash colour transforms apply
as to fills. The bounds count every triangle given, culled
or drawing nothing, with the line's width if a line was set; the hit
tests count the textured triangles; `readGraphicsData` gives each
untextured triangle as a fill, a path and an end, the lines all in one
path, and leaves the textured ones out. Errors are adl's: vertices not in
pairs, or not three a triangle without indices, indices not in threes and
`uvtData` not two or three a vertex are ArgumentError 2004, a culling
not one of the three 2008, after them; null vertices draw nothing; a
`GraphicsTrianglePath` refuses a culling as it is set, 2008. Where an
open contour went on after triangles, adl reads it back from the pen to
where it began, and the player from where it began through the pen; and
a filter's output or a cached bitmap over textured triangles adl keeps
though the texture changes, which the player draws again; adl keeps them
over a path's bitmap fill too, so this is any bitmap fill's limit, not
the triangles'. adl hits a culled drawing's triangles where it last drew
them on the screen, so a hit test asked after a flip, before the next
frame is drawn, finds them where they were; the player's, where they
now are.

`readGraphicsData` reads a drawing back as Flash does, from the shape in
twips rather than the commands (`display/graphicsdata.ts`): each fill as
its fill, one path and an end; each line as the outline Flash strokes it
into, a nonZero fill of its colour, with its caps and joins; cubics as
quadratics; colours through Flash's premultiplied store; and with
`recurse`, its children's through their matrices. The `read-graphics-data`
case holds adl's output. Lines a few pixels wide and the outlines of
curves still stray from adl's by a twip.

## Bounds and hit tests

A display object's bounds are what it draws and what its children draw,
in its own space: for a shape from the SWF the rectangle DefineShape
recorded, with the lines' widths for `getBounds`, `width` and `height`
and without them (`edgeBounds`, where the shape has one) for `getRect`,
as Flash reports the recorded rectangles even where the shape's edges
disagree with them (the corpus's `displayobject_getrect`); for a
drawing, the extent of its paths, curves at their true extremes, with
the lines' half widths and square caps for the bounds with lines; for a
container, the union of its children's bounds, each through the child's
matrix, with its own drawing's. `width` and `height` are the bounds
through the object's own matrix, in its parent's space, or what that
would be for one with no parent, so a turned square is wider than its
side and a scaled shape never added is as wide as its scale makes it
(the `draws` case); setting one scales the
object so that the bounds come to the value, and leaves it when the
bounds have no extent to scale, as Flash. `getBounds(target)` and
`getRect(target)` take the bounds through the matrices up to the stage
and back down into the target's, or stay in the object's own for null.

What is reported is in twips, as Flash keeps positions: a turned square
of side 50 is 61.25 wide, not 61.237 (the `draws` case). Flash's bounds
of a line come out about half a pixel wider than its geometry with its
half width, by a rule not known yet, so the case reports its drawing's
`getRect`, which has the lines' paths without their widths. `scaleX`,
`scaleY` and `rotation` are kept apart from the matrix, as Flash keeps
them: see [Scale and rotation](#scale-and-rotation).

`hitTestPoint(x, y)` takes its point in the space of the main root, as
Flash does (the corpus's `displayobject_hittestpoint_root`: moving the
root moves nothing under the point, moving a loaded SWF's root does):
against the bounds, or, asked for the shape, against what is drawn, a
fill where the point is inside by the fill's winding rule, the parity
of its contours around the point or the sum of their orientations, as
the renderer fills it (the `draws` case hits the inner square of the
non-zero pair and not the even-odd one's), and a line where it is within
half the width of a path, children included. Flash finds nothing on an
object not yet drawn and off the stage, as the oracle's harness has a
document class in its constructor; the player does not model that.
The shape test samples half a pixel to the left of the point, on its
row, which is how Flash's answers on a shape's edges come out: a point
on its right edge hits, one on its left, top or bottom edge does not
(`displayobject_hittestpoint_boundary`, both ways round). The shape test
asks for a SWF's root above the object, the bounds test does not; the
stage counts as one, with the main SWF's `LoaderInfo`, so that what a
script puts on the stage itself has the stage for its `root` and takes
the pointer's hits, as a window over the whole movie does in Flash (the
`stage-hits` case). The stage's own shape test still hits nothing, as
adl's does, though its bounds test hits its children. `hitTestObject`
asks whether two objects' bounds in the stage's space overlap. The
corpus's `displayobject_getrect`, `_hittestpoint`, `_hittestpoint_root`
and `_hittestobject` are the reference, with the `draws` case.

## Scale and rotation

Flash keeps a display object's `scaleX`, `scaleY` and `rotation` apart
from its matrix, and the player does the same: the four are the object's
own, the matrix is made from them, and a matrix set whole, by a
`PlaceObject` or `transform.matrix`, is taken apart into them, the
scales by the lengths of its columns and the rotation by the angle of
the first, a skew by the second's. So `scaleX = -0.5` reads back as
-0.5 and halves the width, where a matrix taken apart would read 0.5 at
a half turn; and `width` sets `scaleX` to the value over the object's
untransformed width, positive, from a scale of 0 as well as from any
other, and a negative width changes nothing, as Flash has it (the
corpus's `displayobject_width` and `_height`, 4852 and 6052 lines of
ramps, in twips: a drawing thinner than one is no width, so `nan_scale`'s
`Number.MIN_VALUE` square is as good as none). A scale set stretches its
column of the matrix in proportion, so the other column stays exactly as
it was, and a scale set to NaN reads back NaN and zeroes its column; a
NaN rotation reads back NaN and leaves the matrix; a NaN position is 0
(`displayobject_invalid_floats`). Rotation is reported in Flash's
range, -180 to 180, both ends as given. The ramps
add to what the getters return, so each step's value rests on the one
before, and they part from the player where Flash's arithmetic does from
IEEE's: Flash Player's `-0.9981818181818182 + 1/550` is not the nearest
double to the sum, which the 32-bit player's x87 extended precision
explains, as it does the avmshell's (see [Testing against
oracles](testing.md#testing-against-oracles)); swf2es follows IEEE
doubles there too, so those two tests cannot be matched to the end.

`flash.geom.Matrix3D` keeps its 16 components in a `Float32Array`, in
`rawData`'s column-major order. Its constructor accepts a vector of exactly
16 values; otherwise it starts as the identity. The getter returns a new
`Vector.<Number>` each time, and the setter and copy methods round writes to
float32. `copyRawDataTo` pads a growable vector with zeros out to its index,
as adl does however far, but refuses an index from 2^28 on, a negative one
too, with ArgumentError 2004 before writing anything. Its arithmetic
(`display/matrix3d.ts`) is Flash's float32, to the last bit where adl was asked:
products and sums each rounded, `recompose`'s Euler angles through float32
sines and cosines, `appendRotation` with the axis made a unit one in
float32 and the pivot multiplied on, `invert` by Gauss-Jordan elimination
with partial pivoting in float32, and `decompose` making the columns
orthonormal one after another, so a skew goes and a mirror is the z
scale's sign. `interpolate` lerps the translations and scales and slerps
the rotations, and applies the scale after the rotation, as adl does;
Ruffle's corpus drops the scale. Before SWF 13 Flash had the determinant
of the other sign and turned about an axis as given, not a unit one, and
the player does so for such SWFs (`matrix3d-swf12`, `matrix3d-swf13`).
`pointAt`, a stub in Ruffle and Shumway, is adl's to a float32 rounding
or two (`point-at`): `at` turns to face the point from the matrix's
position and `up` to the world's (0, -1, 0), each made square to the
other; left out they are (0, 1, 0) and (0, 0, 1), not the documented
(0, 0, -1) and (0, -1, 0). The scales `decompose` finds go with the
facing frame's axes, x across, y up, z along `at`, and the skew it drops
stays, so a skewed matrix stays skewed; a direction of no length in
float32 leaves the matrix as it was, and a NaN makes it all NaN.
`Utils3D.pointTowards` interpolates a copy toward the matrix's
translation alone turned so, the percent held to 0 to 1, so its scale
goes to 1. `Utils3D.projectVector` and `projectVectors` divide as adl
does, which the Flash Player of Ruffle's corpus rounds further. A field of view a
focal length gives goes through `atan`, whose last bit Flash's C library
decides, so `perspective_projection`'s ramp matches only in part.

A display object goes into 3D once a script sets `z`, `rotationX`,
`rotationY`, `rotationZ` or `scaleZ`, even to what it was, sets
`transform.matrix3D`, or sets `transform.matrix` to null; setting
`matrix3D` to null takes it back to 2D at the identity, and setting a
matrix takes it back with that matrix (the `three-d` case, the corpus's
`displayobject_z` and `geom_transform`). In 3D `transform.matrix` is null,
and the properties are kept as set: a rotation is not brought within
±180, a NaN position or rotation is 0. `matrix3D` is the object's own
Matrix3D, live as adl's (`three-d-matrix`): the getter gives the same one
each time, which shares the object's matrix, so that what a script does
to it moves the object, its properties taken apart from it again (the
Matrix3D's natives tell its owner), and what the properties do shows in
it. Its copyToMatrix3D, copyRowFrom and copyColumnFrom change the
Matrix3D alone, as adl's do: the object is drawn and reports its
properties as before, from a copy of its matrix the view goes by, until a
property set writes that copy back into the Matrix3D (`three-d-matrix-shared`,
`three-d-matrix-silent`). A matrix3D set whole becomes the object's own, a clone of the same
values too, and is taken apart as `decompose` takes it; one that is
another object's is ArgumentError 2189, until that object lets it go
(set to null or another). A position set moves it alone, and a scale or
rotation set makes it again from all the properties, translation ×
rotation about x, then y, then z × scale, the angles' sines and cosines
taken of float32 radians, as adl's are to the last bit, and the
translation put in its column, so an infinite scale's column is infinite
where the rotation's is 1 and NaN elsewhere; an object with a NaN in its
matrix is not drawn. Each of these setters is a touch. A `PerspectiveProjection` of its own measures 500 pixels wide;
one a transform gives reads and writes its object's, as Flash's does,
which keeps the field of view in radians, the stage's 500 wide and the
others' as wide as the stage; the stage and each SWF's root always have
one, back to their defaults when set to null. `transform.pixelBounds` is
the bounds on the stage out to whole pixels.

## 3D display objects

A 3D object is drawn, bounded and hit in perspective, as Flash Player 32
(PepperFlash) and adl draw it (`display/perspective.ts`). Its projection is
that of the nearest container above it with one set on its transform, or
else its SWF's root's, or the stage's for one on the stage: the centre in
that container's own space, the root's at the stage's centre, and the
focal length the field of view's over the stage's width. Its matrix3D,
those of the 3D objects above it and the 2D matrices between go into one
3D transform to the container's space, which the projection divides, a
point at depth z drawn at f / (f + z) of its distance from the centre: a
3D object in another is in one 3D space with it, not flattened into the
other's plane (the `three-d-scene` case's green card in the blue). Each
object's plane is then a projective map of its space to that container's,
and a 3D object's `placed` matrix is its plane in its parent's, the
parent's inverse after its own: a `Projective` matrix, whose third row
`geometry.ts`'s functions divide by, so bounds, hit tests, the pointer's
pick, `mouseX`, `localToGlobal` and `globalToLocal` follow it as they
follow any matrix, and 2D objects pay one test. It is kept on the object
until anything is invalidated, as an ancestor's move changes it.
`local3DToGlobal` projects a point of the object's 3D space so, which
Flash reports to a quarter pixel; `globalToLocal3D` is the point of the
object's plane under the stage's, at z 0.

Bounds through a plane are out to whole pixels, as Flash reports them:
a turned card's `width` is its drawn width (`three-d-flip`). An edge that
passes a whole pixel by less than an eighth of one is not counted to the
next, as adl reports fourteen edges of `three-d-bounds`. A 3D object's box
in another space is that box on the stage (its projector's space), taken
there as a box: so under a turned 2D parent, its box in the parent is the
box of a box, larger than what is drawn; in a 3D parent, it is through
its flat matrix, without perspective, as its `width` is. A 2D object's
box in a space it shares a plane with is measured only up to where the two
meet. adl reports a 3D object's `concatenatedMatrix` as null, and that of
a 2D object in one in the space of the bitmap the 3D object is drawn into:
up to the 3D object, then two pixels out from its bounds' top left out to
whole pixels. `localToGlobal` through a plane is to a whole pixel and
`globalToLocal` to a twip. Before a 3D object is first drawn, adl's bounds,
concatenated matrices and points of anything on its list are not yet
made, its concatenated matrices five times their size, and the cases read
them a frame later. An object with a
corner of its bounds at or behind the eye (f + z at most 0) Flash draws
none of, takes no hit on and counts in no bounds; its own bounds are an
empty rectangle at the origin. `hitTestPoint` without the shape flag
tests the box around what is drawn on the stage, and the pointer picks
where the plane is drawn (`pointer.test.ts`, against Flash Player 32's
traces). Siblings are drawn in the list's order, whatever their depths.
A 3D mask masks nothing, and is not drawn; set on a 3D object, it leaves
none of the object drawn.

Flash draws a 3D object from a bitmap of what it and its children draw in
its own space, a texel a pixel of that space whatever its scale, its
parent's or the stage's zoom, then draws the bitmap smoothed through its
plane; so a 3D object scaled up is blurred, a texel magnified, where a 2D
child scaled up inside it is sharp, and its filters are in its space and
turn with it. The colour and alpha of all above it go into each of its
fills in the bitmap, so a card under a half-transparent parent shows its
own white square paler than its edge, not as a layer faded whole; its
blend mode composites the drawn bitmap, its filters' result included,
with what is behind it (`three-d-filter-blend`); and its
scrollRect counts for nothing, Flash drawing, bounding and hitting all of
it (`three-d-mixed`, the same in adl and Flash Player). The view does the
same (`scene/view.ts`, `drawPlane`, with `scene/planes.ts` and
`display/plane.ts`): what the
object and its children draw, coloured from the stage down, is drawn in
a pass of its own before the frame's into a bitmap of the object's
bounds (filters' reach included) out to whole pixels, at 4 samples a
side averaged down to a texel a pixel, as the stage's edges are
anti-aliased, with a texel of nothing around, and kept as a kept output;
in its place in its parent is a quad of the bitmap's four corners, each
with the w its plane gives it, so that the GPU interpolates in
perspective, which carries the blend mode. Where the samples would pass
the GPU's largest texture or 4M texels, fewer are taken; past 2048
texels a side, the bitmap holds less than a texel a pixel, and its lines
and filters are made for the units it is drawn at. A 3D object in another draws its quad into the other's bitmap, by its
plane in the other's space, so the two are drawn deepest first. Its
hairlines are a texel. The bitmap is drawn again only when what is in it
changes, not as the object moves or turns: 100 turning 3D rigs of 12
parts each, all animated, take some 1.9 ms of sync a frame, and turning
alone 0.1 ms. As adl and Flash Player measure it, the bitmap is drawn a
texel wider and taller than it is, about its centre and half a stage
pixel right and down, which at a texel a pixel keeps its left and top
edges in place; and sampled once a pixel of the stage, at the pixel's
centre, which the shader does for each of the target's samples of the
pixel where the host says how many there are (`screenScale`), as the test
page does; the evidence for that last is mixed, edges matching better
with it and magnified bitmaps no worse. A BitmapData's draw of an object
on no stage projects what is in 3D in it as on a stage the bitmap's
size, centred on it, as Flash does.

A 2D mask set on a 3D object clips the bitmap, in the object's space, as
adl shows (`three-d-mask`). One in the object clips it there as it would a
2D object. One outside it is placed by its matrices up to the nearest 3D
object above it, or the stage, and then moved as if the bitmap's corner,
the top left of the object's bounds in its own space, were where the top
left of its bounds is on the stage, rounded to a pixel: so a band over a
turned card leaves a strip of the card that is not under it, and a card
nearer the eye has its part under the mask magnified. The view draws a
copy of the mask's Graphics and sprites in the plane's holder, which
clips the object's container there, and keeps the mask itself out of the
stage's build. The copy, and the object's bitmap, are made again only
when the mask's place in it, which follows the object's bounds, or what the
mask draws has changed (`three-d-mask-moving`): a still card under a still
mask keeps its bitmap, as one with no mask does. Flash's mask cuts at whole
texels, the view's at a quarter of one, so the edges fall up to a texel
apart. Under WebGPU, which the quad's shader has no program for, a 3D object
draws as its matrix3D's x and y rows.

adl draws through a focal length for a stage 500 wide whatever the SWF's,
and a projection set on the root as if it were not, where Flash Player
draws as its bounds and `local3DToGlobal` say, in both: the player follows
Flash Player, and the `three-d-*` cases, whose references adl draws, have
stages 500 wide and leave the root's projection alone. Flash's
anti-aliasing of the bitmap's edges and its hairlines' place in it (a
pixel's row, where the view straddles two) differ by a level or a pixel
at edges, within the cases' tolerance. For an object hidden behind the
eye adl still projects its 2D children's bounds through the negative w,
and `hitTestPoint(0, 0, false)` on it is true; the player gives such an
object no bounds and no hits.

Left as they are: adl composes a 2D matrix a scale or rotation setter
makes in 16.16 fixed point (scale cut, sines and cosines rounded, so
`rotation = 30` reads `a` 0.86602783203125 and `scaleX = 0.1` reads
0.0999908447265625, a scale below 2^-16 nothing), in 2D as well, and it
goes into the matrix3D as the object enters 3D; a scale set after a whole
matrix makes all four of its numbers again. The player keeps doubles, and
stretches a column in proportion as the corpus's `displayobject_invalid_floats`
has Flash Player do: matching it is a change to every 2D matrix, for
differences below 2^-16 of a scale, and shows in bounds in a turned
parent to a twip. A hairline in a 3D object's bitmap straddles two texel
rows where Flash's covers one, as on the stage.

## Nine-slice scaling

A sprite, movie clip, button or `Shape` with a grid, its symbol's
`DefineScalingGrid` (a character id and a rectangle in twips, which
`format` reads and the timeline keeps on the sprite or button character
for its instances) or the `scale9Grid` a script sets, draws its shapes
sliced (`display/scale9.ts`): its own drawing or shape, and its `Shape`
children's, each vertex, taken through the child's matrix, moved by a map
of each axis through the edges of the bounds the grid divides and the
grid's, so that in its parent's space the corners keep their size, the
edges stretch one way and the centre both. Scaled smaller than its
corners, they share the size in proportion and the centre has none. Its
sprites, texts and bitmaps, and the shapes in them, scale as ever, and so
do its bounds, `width` and `height`. What adl showed, on panels of
coloured bars measured to the pixel:

- The bounds a grid divides are what the object draws, without lines,
  and what each child draws itself, in the child's own space, its matrix
  ignored, and nothing of a grandchild's, a text field's or a static
  text's: a child's bars
  moved 30 to the right leave the edges where the panel's are (its bars
  then pass the corner at the corner's rate), a child sprite's drawing at
  110 to 120 moves the right edge to 120 wherever the child is placed or
  however it is scaled, a grandchild's moves nothing, a bitmap's or a
  video's counts. A SWF shape's are its recorded bounds, its lines with
  them; a MorphShape's are its blend's at the ratio it is drawn at, from
  the frame that sets the ratio: the panel slices by the new blend as it
  draws it, though the morph takes the blend only in its own draw.
- The map goes by the object's own matrix, not its place on the stage: a
  grid under a parent scaled 3 and itself unscaled changes nothing, and
  one scaled under a turned or mirrored parent is sliced, its corners
  their size in that parent's units.
- It slices only under a scale alone: `a` and `d` positive, `b` and `c`
  under a 4096th (adl slices b = 0.000244 and not 0.0002442, a 16.16
  fraction under 16). Turned, skewed or mirrored, it scales as ever.
- Only vertices move, curves' control points too: a triangle's long side
  across the regions stays straight, a quadratic from 0 to 40 under a grid
  at 20 bends to its moved end, and a fill's gradient or bitmap stretches
  as ever. A line is as wide as the owner's parent's transform makes it,
  for every scale mode, times a `Shape` child's own scale: a 2 pixel line
  in a child scaled 2 is 4 wide whatever the owner's scale.
- A grid not strictly inside those bounds both ways, as they are when it
  draws, is ignored, so one on a fill's edge does nothing, but one on a
  SWF shape's fill edge inside its lines' recorded bounds slices.
- A scrolled object slices in its drawing's space and then scrolls: a
  `scrollRect` from -20 moves the sliced bars 20 of its units over.
- A mask is not sliced, in drawing or in hit tests: neither an owner that
  is a mask nor a `Shape` child that masks a sibling, by a script's `mask`
  or a timeline's clip layer, common in a 9-slice symbol, nor an owner
  inside a mask, which a shape test hits nothing of, as of any mask and
  what is in it: what the mask clips is hit where its unsliced drawing
  is. Neither is what `BitmapData.draw` draws through its matrix,
  whatever the source's own scale; a sliced object inside what is drawn
  is.
- A `Shape` moved from a sliced sprite to a plain one draws unsliced, and
  one moved the other way, or between two grids, takes its new parent's.
- A button slices the state that is one shape; a state of several
  characters is a sprite of them, and scales as ever.
- Hit tests find what the slice draws (`display/bounds.ts`), the point
  against the sliced layers, kept by the slice's key, but only within the
  bounds the shape has unsliced, its own, lines included, in its own
  space: in a panel 100 wide scaled 2, a bitmap child 130 wide stretches
  the panel's fill to 230 and it is hit to 200; a bar of its own at 88
  drawn at 218 is not hit; a Shape child's fill from 10, drawn from 10,
  is hit from 20; a line to 110 hits the fill to 220. Between a change
  and the next draw, adl's hit tests still find the slice last drawn, or
  an owner's redrawn shape unsliced; the player's find the new slice.
- `scale9Grid` reads x, y, width and height each cut toward 0, a tag's
  grid of 20.5 to 80 as (20, 59 wide). The setter keeps them so cut, and
  then, for a grid not strictly inside the bounds it divides as given, or
  for an object with none, throws ArgumentError #2004, keeping it; null
  takes it away.

The renderer reshapes the layers when a slice applies, keyed by its
edges and, for a `Shape` child, its matrix, and a drawing's version, which
Graphics counts as it changes the drawing in place, and draws them as a
drawing's are, fills and lines its own, not the shape's shared ones: a
panel rebuilds as it is resized, not on every frame it is drawn. The slice
is computed again only on a sync where the owner's scale, grid, drawing,
children or a direct child's drawing changed, a `Shape` child's matrix or
parent, or a mask role, not as anything moves: a sliced panel dragged
across the stage for 40 frames, under a moving parent and with an
animated grandchild, made its slice and its sliced layers once, on the
first frame, and slicing allocated nothing after. A drawing keeps its
bounds per version, and an object its last slice, which a hit test finds
again rather than making on each pointer move; a set of layers keeps its
four latest slices, for instances of one symbol at a few sizes. The line
of a sliced shape is stroked through its stage transform as ever and as
wide as above. The `scale9` case draws panels with `DefineScalingGrid`,
stretched, shrunk past their corners, turned, flipped, in a button, on a
fill's edge, with a half-pixel grid, with a sprite in them, and a script's
grids, refused ones too, and rescales some on its second frame;
`scale9-changes` changes what the grid divides, moves, redraws, adds and
removes children, turns a parent, gives a Shape a grid of its own, draws
through `BitmapData.draw`, masks, scrolls and hit-tests a curve across
the grid; `scale9-hits` hit-tests panels whose children widen what the
grid divides, from the start and as they change, and a panel inside a
mask, and draws one whose MorphShape child changes ratio. Flash snaps
straight runs of lines to whole pixels, which the player does not, so a
grid's lines at half pixels part from it there as unsliced ones do.
Flash's hit tests on a curve land about half a pixel lower than the
player's, sliced or not.
