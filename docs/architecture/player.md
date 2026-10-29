# The player

The player keeps Flash's display list and timeline
(`packages/player/src`: `display/timeline.ts` reads a SWF's definitions and
frames, `display/display.ts` gathers the display list, whose kinds of
display object each have a module of their own: `displayobject.ts`,
`container.ts`, `movieclip.ts`, `buttonobject.ts`, `shapeobject.ts`,
`textobjects.ts`, `bitmapobject.ts`, `videoobject.ts`, with `walk.ts` for
the frame's walks and `instantiate.ts` for what a character makes), and
the renderer draws it (`scene/view.ts`, `RenderView`): each frame it walks
the display list into a scene list for `@swf2es/render`, keeping what a
display object drew while it is unchanged (see [Rendering](rendering.md#rendering)).

## Source layout

`packages/player/src` is grouped by what each part of the player does,
and the player's paths in this document are relative to it:

- `index.ts` is the package's default entry point; the separate experimental
  `@swf2es/player/context3d` entry installs Stage3D natives only when requested.
  `workers/thread.ts` is the entry a background worker imports
  (`@swf2es/player/worker`, with the primordial's messages in `workers/protocol.ts`);
  `player.ts` runs a SWF,
  `scripting.ts` connects it to the runtime and the compiler, with its
  parts in `scripting/`: `code.ts` compiles and links the SWFs' code
  into their application domains and tells whose code runs, `sha256.ts`
  names the ABCs it compiles, `events.ts` dispatches events to AS3
  listeners, `lifecycle.ts` tells display objects they were added or
  removed and keeps the orphans, `loads.ts` takes what Loaders and
  URLStreams ask for through the host and gives it to a frame,
  `symbols.ts` keeps what SymbolClass
  bound classes to, the fonts registered and the sounds' shared decodes,
  `timers.ts` keeps the clock and the timers that fire by it,
  `clipboard.ts` what the clipboard holds and when scripts may touch it,
  `workers.ts` the workers as one VM sees them, `handover.ts` the
  modules the primordial hands them (see [Workers](services.md#workers)).
  `hosts.ts`
  holds what a host may supply in place of the browser (navigation,
  shared objects' storage, the platform Capabilities reports, the
  clipboard's writes) with the browser's defaults, and the interfaces of what only a host supplies
  (ExternalInterface's page, a renderer's draws, fetches, sockets, the
  threads workers run on).
- `display/`: the display list and the timeline, and what they are made
  of: shapes, morphs, drawings and what they read back as, bounds and hit
  tests, 9-slice scaling, geometry, 3D matrices, colour transforms,
  gradients' ramps, and filters as records of their values.
- `text/`: text fields' model and layout, static text, fonts and CSS.
- `bitmap/`: the pixel store and its operations on the CPU, bitmap
  filters, decoded images and PNG encoding.
- `media/`: sound: decoding and the host's device (`audio.ts`), MP3
  frames' headers (`mp3.ts`), what `Sound.extract` reads (`extract.ts`),
  and the sounds the player plays, the timeline's and scripts' channels
  (`sounds.ts`).
- `input/`: the pointer and the keyboard.
- `scene/`: the view that drives `@swf2es/render` (`view.ts`,
  `RenderView`, `@swf2es/player/scene`: the display list's walk, its
  passes for `BitmapData.draw` and 3D objects, the canvas and its
  context) and what only it uses: shapes' fills resolved (`fills.ts`)
  and made geometries (`shapes.ts`), kept while drawn with bitmaps'
  quads and glyphs' fills (`parts.ts`), the textures paints sample
  (`paints.ts`), a stale bitmap cache's shapes (`stale-shapes.ts`),
  lines stroked (`strokes.ts`) and kept by the transform they are seen
  through (`lines.ts`), masks (`masks.ts`), filters worked out into
  passes (`filters.ts`) and a filtered object's layer and kept output
  (`filter-layers.ts`), 3D objects' bitmaps and quads (`planes.ts`),
  text as items (`text.ts`) drawn with device text's runs
  (`text-items.ts`) and advanced text's glyph quads (`advanced.ts`), the
  pointer on the canvas (`pointer.ts`) and the context menu
  (`context-menu.ts`).
- `playerglobal/`: the `flash.*` classes, a path per package and class,
  and the AIR classes the player declares itself (`air/`, see
  [AIR's WebSocket](services.md#airs-websocket)).

`playerglobal/` holds AS3's bindings only, and depends one way: its
natives and hooks import the rest of the player, and the rest imports
playerglobal once, where `scripting.ts` registers `playerNatives` and
`playerHooks` from `playerglobal/index.ts` with the runtime. What the
player needs for itself, though a `flash.*` class shows it to scripts,
lives outside it: event dispatch, the host interfaces, the timeline's
sounds and the channels' state, a display object's root.
`tests/unit/boundaries.test.ts` rejects any other import of it.

`Scripting` (`scripting.ts`) is the runtime with playerglobal registered,
the display object its `create` hook takes, and the frame: its events,
frame scripts, gotos' cycles and the construction of what timelines
placed. What else scripts need that keeps state of its own is a part it
holds, a class in `scripting/` given the `Scripting` for what they
share: `code`, `symbols`, `lifecycle`, `loads`, `timers` and `workers`. The natives
and the player reach a part through it, as `s.loads.requestLoad`; the
host's own calls, `loadLibraries` and `settled`, stay on `Scripting`.

The unit tests mirror this tree: `tests/unit/player/<path>.test.ts` tests
`<path>.ts`, a playerglobal class's under
`playerglobal/flash/<package>/<Class>.test.ts`. `tests/unit/mirror.test.ts`
rejects a test that mirrors no source, but for the few that cut across
modules, which it lists with their reasons.

## Scripts and the display list

An AS3 SWF's display objects are AS3 objects: a timeline child whose
symbol has a class (`SymbolClass`) is an instance of that class, the root
is one of the document class, and `new Sprite()` in a script is on the
display list once added. The player keeps one object with two faces, as
Ruffle and AwayFL do: the runtime allocates every instance of
`flash.display::DisplayObject` and its subclasses through a `create` hook
on that class (hooks' allocation is inherited through `Traits.create`),
which attaches a player `DisplayObject` as `$display`, and the player's
object points back with `object`. The natives of the display classes
(`packages/player/src/playerglobal/flash/display/...`) read and write
`$display`. They are written as a class of getters, setters and methods,
whose members `registerNativeClass` (the runtime's `natives/define.ts`,
beside `plain`) registers under the names the compiler binds, `Class#get:x`, `Class#set:x`,
`Class#method` and `Class.method` for a static, each through `plain()`,
so it runs with the AS3 object as `this`; the class is only how they are
written, and a private native is registered by name beside it. The class
lives in the factory that makes the natives, so it closes over its
`Scripting`; an AVM1 movie's children, and a timeline child without a
class, have `object === null`, and nothing in `display/display.ts` or `scene/view.ts`
depends on which VM drives them.

Construction follows Flash's order, which playerglobal's own constructors
fix: `Sprite()` calls its private native `constructChildren()` after
`constructsuper`, so a symbol's first frame's children's classes are
constructed before the subclass's constructor body runs and can reach
them by name. The player constructs a timeline child whose symbol has a
class by making its player object, placing its first frame's children,
setting it as the one pending, and calling `rt.construct(cls)`: the
`create` hook takes the pending object instead of making one, and
`constructChildren` makes the placed children alive, so the constructor
finds them in `numChildren` before `super()` and constructed after it, as
the main and a loaded root do too (`instantiation_on_enter_frame`). A `new
Sprite()` from a script finds nothing pending, gets a fresh player object,
and places its first frame in `constructChildren`. Only a MovieClip plays
its timeline: the `create` hook stops a symbol of more than one frame whose
class extends Sprite but not MovieClip, the root's included, on its first
frame, as Flash does, where fl.controls' components keep their skins on a
second frame (the `sprite-frames` case). A frame played on
places its new children at once, but makes their AS3 objects only after
`ENTER_FRAME`, in a construct phase before `frameConstructed`: until then
a script counts them in `numChildren` and `getChildAt` gives null. Their
classes are ready as the frame plays, their scripts run, and one taken off
before the phase is never made (`delayed_symbolclass`). A goto makes what
it places at once. `EventDispatcher()` calls its private native
`ctor`, and `InteractiveObject()` calls `addEventListener`, so event
dispatch is part of the first slice: listeners by type and phase on the
player object, `dispatchEvent` through the player's parent chain
(`scripting/events.ts`), and the frame events the player broadcasts.
The player makes its events of an object put on the list or taken off
only where a listener on the object or above it would hear them: where
none does, no script runs, and none could tell. An event keeps its
fields in AS3, Event's and its subclasses' private variables, which
compiled code reads as slots: dispatch writes the target, current target
and phase into Event's and reads its flags there, by the slots
`eventFields` finds once (under Flash Player's playerglobal, the fields
its natives keep). An EventDispatcher made with a target dispatches as
that target, along its parent chain, its own listeners seeing the target
as the current one (`event-fields`).

A display object nobody named is named as its AS3 object is made,
`instance` and the next of one count for the player, which every SWF it
loads shares: a timeline child the SWF names takes none, nor does the
main SWF's root, `root1`, and the stage has no name (`instance-names`).
Only a name from the SWF gives its parent a property of it.

## The frame

A frame runs in the order Flash runs one, which the Flash oracle fixed
case by case: the timelines advanced, which places children and
constructs their classes as it goes; `ENTER_FRAME`; `FRAME_CONSTRUCTED`;
the frame scripts `addFrameScript` registered, once for each frame a clip
enters and again for what a script's goto changes; `EXIT_FRAME`; `RENDER`
when a script invalidated the stage; then the frame is drawn. The first
frame, after the document class is constructed, has no `ENTER_FRAME`
(`events`). The frame events are broadcasts: each display object that
listens hears its own, on the display list or not, in the order the
objects first listened, with no capture or bubble phase. And `SymbolClass`
binds its classes after an eager `DoABC` has run its initializer, so an
instance that initializer makes of a bound class has no timeline children,
and one the constructor makes has (`init`). A goto a frame script asks for
waits until the script returns: `currentFrame` and the children read as
before it through the rest of the script, then the jump happens and the
frame it lands on has its script run in the same phase (`gotos`), before
the script of any child the jump placed, which is constructed with its
parent already on the landing frame (`gotoChild`); a goto from anywhere
else happens at once. All the timelines advance before any frame script
runs, parents' scripts before their children's (`nested`); the clips
whose scripts are to run are fixed as the phase begins, so one a script
removes still runs its own (`loads`, `orphans`).

A frame walks the whole display list once to find the clips that
advance, and once for each round of frame scripts, which a busy scene of
some 13,000 objects felt. A walk reads each object's `frameChildren`, a
container's own children array, a button's states, one empty list for
the rest, and its `kind`, not its class, and calls into no object with
nothing under it. Each container keeps the list of clips and buttons at
and under it in that order (`walkList`), with where each clip's own end,
for one that sits a frame out with all it holds; a clip or container that
comes, goes or moves under it drops the lists from its parent up, and the
next walk makes them again, copying those still kept below (a list of
fewer than 32 is not kept, but walked again within its parent's). A
shape or text swapped, as a timeline swaps them on every frame, drops
none. So a frame visits the clips alone, not every container: in
`walk-bench.ts`'s 13,000 objects a tick went from 284 to 117 µs and a
round of scripts from 122 to 44, for some 25 bytes an object. A
button's states, which it changes without its parent knowing, are walked
as they are. Another round runs only when the last ran a script and
something a round reads changed since it walked, which `scriptWork`
counts: a clip's frame, its frame scripts, `makingChildren` or
`timelineChild`, a children list or a button's states, an object made
alive, the orphans, what scripts made and the scripts' phase. A round
leaves each clip it lists on a frame whose script ran, or held back as it
would be again, so with none of those changed another finds nothing; a
frame whose scripts only stop their clips or set properties takes one. The
checked build's tests (`pnpm test:checked`) run each round left out
anyway and fail if it finds anything to do.

In a SWF of version 9 or earlier, a clip a script sends to a frame, by a
goto from its frame script, its listener or another clip's, sits the next
frame out with everything in it: none of them advances, and from the
frame after they go on as before (`goto-children`, recorded as version
9). A goto to the frame it is on counts, so one sent there at every
`ENTER_FRAME` stands still with all in it; a clip off the display list
sits its next frame out there and no later one; and a kid sent to a frame
in the frame its parent was sits out the parent's frame only, not one
more. The player keeps the frame count of the goto on the clip, not a
flag. From version 10 a goto leaves the frames that follow as they were.
The version is the clip's own SWF's, which the case does not try across
a loaded SWF.

From version 10 a goto, once it happens, runs a frame of its own: what it
placed is made alive, and anything frames placed that is still waiting to
be, then `FRAME_CONSTRUCTED` is broadcast, the frame scripts due anywhere
on the display list run, the goto's new frame's among them, and
`EXIT_FRAME` is broadcast, all before the goto returns to a listener that
asked for it, or before the frame script that asked for it is left behind
(`goto-cycle`, `goto-cycle-nested`). A goto in one of those scripts runs
its own inside, and the frame's own phases then find the scripts already
run. A script's goto on itself waits for it even while another clip's
cycle runs inside it. Two scripts that send their clip to each other's
frame nest cycles without end; Flash gives up some 1400 deep, and the
player throws AS3's stack overflow, #1023, at 256, after which no goto
cycle runs for the rest of the frame, so scripts that catch it cannot
start it over. A frame script that asks for a goto and then throws still
has its goto, and the scripts after it still run, as adl has it. What a
goto's cycle runs throws no error into the goto's caller: an error a
script, listener or constructor in the cycle throws is reported as
uncaught, and the cycle and its caller go on, as in Flash and Ruffle.
The goto itself still throws to its caller its own errors: the stack
overflow, #1023, and an unknown scene or label, #2108 and #2109.

A button made in a SWF after version 9 whose up state has a clip runs
such a frame too, once its states are made and its parent has its named
property, before its own constructor: the frame scripts due on the
display list, the orphans' and those of what scripts made, its states'
among them. A clip whose `super()` is making that button has its first
frame's script run there if it registered it before `super()`; else it
keeps it for later when a timeline placed it, by a frame or a frame
script's goto, or a script made it with `new` outside the frame's own
frame scripts, and one a frame script made loses it, as adl shows
(`button-frame-order`, Ruffle's `frame_script_button_order`). Before its
`FRAME_CONSTRUCTED`, that frame makes alive what is placed and not yet
alive, as a frame's construct phase does: so a goto places every child
of the frame it lands on before it makes any alive, and a button among
them makes the rest alive in its early frame, ahead of the clip whose
constructor is making it, as adl shows (`goto-place-first`). A parent's
`FRAME_CONSTRUCTED` listener then finds them all: Flash's own component
parameters are set from one, once for each frame, and a clip made after
it kept none.

A goto plays or stops its clip as it happens, before the frame it lands
on has its script run, so a `stop()` or `play()` there has the last word:
a clip whose every frame stops stays where `gotoAndPlay` from another
clip's script or a listener sends it. A goto a frame script asks for of
its own clip plays or stops it only once the script has returned, over a
`play()` or `stop()` the script calls after it; `nextFrame` and
`prevFrame` past either end stop the clip where it is (`goto-stops`).
`isPlaying` is Flash's own flag apart from the playhead, false for a clip
no script has played, and true still after a deferred `gotoAndStop` or
a `nextFrame` past the end, as adl shows; the player reads the playhead.

A root's scenes and labels come from its DefineSceneAndFrameLabelData;
a timeline without one, or whose data names no scene, a sprite's always,
is one scene named "" whose labels are its FrameLabel tags (`scenes`,
`frame-labels`). The first scene starts at frame 1 whatever its data says,
and a goto finds the FrameLabel tags' labels where the data lists none,
though scripts read none there (the corpus's `movieclip_currentlabels_dupes2`
and `movieclip_goto_scene_last_frame_label`). To a script,
`currentFrame` counts from its scene's first frame, while `totalFrames`
is the whole timeline's. `currentScene.labels`, which `currentLabels`
reads, are the scene's labels counted from its first frame;
`currentLabel` is the last label at or before the frame in any scene;
and `currentFrameLabel` reads FrameLabel tags alone, scene data or not.
`scenes` and `currentScene` make new objects at each read. A goto's
frame number counts from the scene it names, or the clip's, and a label
is found in that scene only: an unknown scene throws #2108, and an
unknown label #2109 where the timeline has named scenes, while in an
unnamed one it is the number 0, frame 1. `prevScene` and `nextScene` go
to the first frame of the scene before or after, or of their own past
either end, and play.

## Errors nothing caught

An error nothing caught is reported, and what was running goes on, as
adl shows. A listener's error never reaches the dispatcher: the
listeners after it still run, and a script's `dispatchEvent` returns as
if none had thrown, whoever dispatched, the player (frame events, a
Timer's, a Loader's, a Socket's, the pointer's and the keyboard's) or a
script. So does the error of a frame script, of a Timer's own tick, of
a load's delivery, of a constructor the timeline or a goto runs, and of
a document class's constructor: the scripts, loads and children after
it still come. The main SWF's root plays on as far as its constructor
got, its first frame's script and its listeners kept, as adl shows; a
load whose document class throws has no INIT or COMPLETE. A host that
passes `onUncaught` to Scripting gets each error as it happens, those
between frames, in a pointer, keyboard or ExternalInterface handler,
included, and `Player.start` and `Player.advance` then throw none; an
error the hook itself throws is kept and thrown as the frame ends. Without it, the frame throws them
once it has run to its end: one alone, or several as an
AggregateError, the one that stopped the frame early, if any, first;
those between frames come with the next frame's. An ExternalInterface
callback's own error goes back to the page that called it. A child its
parent's first frame places is made in the parent's `super()`, and its
error still reaches the parent's constructor.

An AS3 error keeps the JavaScript stack it was made on, out of AS3's
sight (the release player's `getStackTrace` gives null), for a host to
say where an error nothing caught came from: `Runtime.stackOf` gives its
lines from the first compiled method's, whose names begin with `$`.

## A timeline's places over a child

A `PlaceObject` with the move flag that names another character at an
occupied depth makes no new object in Flash: the child stays, the same
AS3 object with its matrix, sign and angle, and only a `Shape`,
`MorphShape` or `StaticText` no script has touched takes the new
character's graphic: a `Shape` or `MorphShape` a shape's or a morph's,
either kind for either, and a `StaticText` a text's glyphs
(`static-text-replace`). Flash also gives a `Shape` a text's glyphs and a
`StaticText` a shape's fills, which the player does not. A clip, a
touched object, and a `Shape` a sprite is placed over all stay as they
were. What touches, by the `replaces` case's 26 depths: the transform
properties (`x = x` counts), `alpha`, `filters`, `blendMode`,
`scrollRect`, `opaqueBackground` and `scale9Grid`, each set to what it
was, and the `transform` setters; what does not: `visible`, `mask` and
`cacheAsBitmap`, whatever they are set to (`scripted-touch`), `metaData`,
`accessibilityProperties`, and `name`, which Flash refuses for a
timeline-placed object with error #2078. The player keeps a `scripted`
flag on the display object for that.

A `Shape` Flash caches as a bitmap (by `cacheAsBitmap`, PlaceObject3's
flag, or filters, for each of which Flash reads `cacheAsBitmap` true)
takes the new shape all the same, but Flash goes on drawing the bitmap it
cached of the old one while the two have the same bounds; with other
bounds it draws the new one (`cache-replace`, `scripted-touch`). The
cache goes stale for good, and the new shape shows, once the object's
scale, turn or skew, its colour or its filters change, or its parent's
scale, or once a frame is drawn with the cache off; a move, by a script
or the timeline, keeps it, as reads of its width do. A mask clips by the
shape it is, not the one its cache shows. The player keeps the shape it
showed, with the matrix and colour it was cached at (`StaleCache`), and
draws it until one of those changes. A `StaticText` draws its new glyphs
cached or not. A clip that loops back over a replaced, cached child is
not covered: adl makes the child anew there yet draws the replacement.

A goto forward does the same, whatever the frames between named at the depth;
a rewind keeps a child placed before the target only if the character
the frames finally name is its own, and makes a new one for another
(Ruffle's `place_object_replace_2`: the same object through two forward
jumps, a new one on the rewind that ends on the other shape). A `PlaceObject`
without the move flag at a depth already taken is let be, whatever it
names, playing or in a goto's replay (`same-depth`, the corpus's
`place_object_same_depth_frame`), and one with the move flag that names a
character where nothing is places nothing (`rewind-first`). A rewind, the loop to the first frame
among them, takes off what the timeline placed after the target, but for
a child at a depth the frames replayed end on a place without the move
flag at, with the child's ratio: that child stays, a clip its character
too, and takes the place, its transform given anew as for a first
placing, and the moves after it; an untouched `Shape` or `MorphShape`
takes the place's shape or morph there, as a move's would (`morph-shapes`,
where the loop puts a morph back over a shape placed later)
(`same-depth`, `rewind-first`); what comes before that place at the
depth, a removal among it, does not matter. The ratio decides, not the
character: authoring tools give each placement a ratio of its own, and
adl shows a rewind take a child whose ratio is not the one the frames
replayed give for another object, whenever it was placed. A later clip of
another ratio, and a clip, shape, morph or text field the first frame
placed that a move after the target gave another ratio, are made anew;
a later child of the same ratio stays (`rewind-ratio`, `rewind-kinds`;
Ruffle's `survives_rewind` compares the ratio only for children placed
after the target, and for morphs, and takes a place with no ratio for a
match where Flash takes it for 0). A clip's own loop makes the
children it places anew alive in the frame's construct phase, after
ENTER_FRAME, as playing on to a frame does; what it takes off is gone by
ENTER_FRAME (`loop-ratio`). Flash's matrix is
exact at the quarter turns, 0 and not the doubles' cosine of 90°, so the
player's is.

A child a script has transformed takes nothing more from the timeline's
places that a script could set: no matrix, colour transform, ratio,
visibility, blend mode or filters, from a move or from the place a
rewind or the loop takes it back to, which leaves what the script set
(`scripted-moves`). Flash keeps this per object, not per property:
setting `x`, even to what it was, keeps the colour transform the moves
give from it too. What touches is the transform properties, `alpha`,
`filters`, `blendMode`, `scrollRect`, `opaqueBackground`, `scale9Grid`
and the `transform` setters, each set to what it was or not, a text
field's `width` and `height` too, which size its field rather than scale
it; a `filters` list refused with #2005 is none; `visible`, `mask` and
`cacheAsBitmap` are no touch here either. The player keeps a `transformed`
flag for this, which every touch sets with `scripted`. A MorphShape a script moved
stays at its ratio. Ruffle's `transformed_by_script` does the same, set
by fewer setters: not by `blendMode`, `filters`, `scrollRect`,
`opaqueBackground` or `scale9Grid`. In adl the 3D setters touch as well,
`z`, `rotationX`, `rotationY`, `rotationZ`, `scaleZ` and
`transform.matrix3D`, and so they do in the player.

## Orphans

A clip a script takes off the display list plays on in Flash, an
orphan, and so does one a script makes with `new` and never adds: its
timeline advances and its frame scripts run each frame, with `parent`
and `stage` null, until it is put back, where it carries on from the
frame it reached, or until it is collected (the `orphans` case; Ruffle
keeps them by weak reference, and so does the player
(`scripting/lifecycle.ts`), with `WeakRef`, so
an orphan nothing refers to stops as Flash's does, and a test that wants
one to play on holds it). What refers to it includes the frame events it
listens for: an `ENTER_FRAME` listener keeps a clip alive in Flash, the
well-known leak, and the player's broadcast sets hold their listeners as
strongly. Flash frees an orphan nothing refers to almost at once, by
reference counting, where the browser's collector may wait minutes, and
a game's removed characters would play on by the thousand; so an orphan
plays for 120 frames at most, then stops on a frame whose script has
run, its timeline sounds stopped, and carries on from there if a script
puts it back. The player cannot see what a script holds, so one held
stops too, where Flash's plays on; one whose subtree listens for a
frame's events plays on, as those hold it in Flash as well. A clip a script makes with `new`, added or not, runs its first
frame's script at the end of that frame's script phase, after the
display list's, in the order made, and sits out the next frame's
advance: made in frame 1, it is on its frame 1 through frame 2 and on
frame 2 in frame 3. The order Flash runs the orphans' scripts in, among
themselves and against the display list's, shifts with the case's layout
(three recordings gave three orders), so the player has an order of its
own, the orphans before the display list, the most recently created clip
first, each subtree in tree order, and the case reports what the clips
logged rather than tracing from them.
The timeline's removal is different: the clip advances and runs the
script of the frame that removed it and then stops for good; and the
property the parent had under the clip's instance name is set to null,
where a script's `removeChild` leaves it. `unloadAndStop` stops a
`Loader`'s content before letting it go, so it does not become an orphan;
`unload` lets it play on, as Flash does.

## A SWF's code

The player loads a SWF's code through `@swf2es/codegen`'s `Codegen`: each
`DoABC`, in tag order, is added to one domain after the builtins and
playerglobal's declarations, all of a SWF's before any of them compiles,
since avmplus has a frame's ABCs loaded before it verifies a method, so a
class in the first tag may extend or name one in the last (the corpus's
`property_priority`, five tags by mxmlc); each is then compiled whole,
by its index in the domain, unless a module cache has it (see [Caching
modules](modules.md#caching-modules)), loaded, and run
unless the tag's lazy flag defers it to its first use, as Flash defers it.
`SymbolClass` then binds character ids to classes by qualified name
through the runtime's name resolution; id 0 is the document class,
constructed on the root clip before the first frame.

A module is loaded as the factory a strict `Function` returns, not
imported: a document keeps every module it imports while it lives, so the
code of SWFs long unloaded stayed (some 4.5 MB a player made again, its
libraries' code and all), where a function's code goes once nothing
refers to it. JavaScriptCore's frames name no script for a
`Function`'s code, whatever its `sourceURL`, so there, as a `Function`
made once tells (`scripting/evaluate.ts`), a SWF's module is evaluated
in a document as a classic script from a Blob URL of its own, which its
frames name and whose code goes with the SWF as a `Function`'s does,
and by a `Function` once a script does not run where a `Function`
does: refused by a Content-Security-Policy without `blob:` in
`script-src` or by Trusted Types, not loaded within 5 s, or loaded but
not run, as by a DOM that runs no scripts. Until one has run, the
modules' scripts go one at a time, so that such a policy reports one
refusal, not one a module. A module whose script did not run is
evaluated by a `Function` all the same, which throws its source's error
where it has one. Without a script, as in a Worker, which has no
document, or under such a policy, JavaScriptCore's frames tell no SWF's
code from the host's, and every SWF's code is the main SWF's to
`Runtime.codeDomain`: its domain for `currentDomain`, a load's default
domain and the rest. The scripts load asynchronously, so a SWF's modules
are all evaluated before any loads into the runtime; where none waits,
the link goes on in the same turn. Measured in WebKitGTK's MiniBrowser, loading
and unloading children as `tests/player/leak.ts` does, the heap after a
collection grew 8.4 KB a load over 290 loads; with a `Function` each,
every child's code taken for the host's made each load's default domain
a child of the last, a chain kept whole, 145 to 234 KB a load. A script
took some 0.2 ms longer to evaluate than a `Function` for a module of
110 KB.

What the player keeps of a loaded SWF beside the SWF itself, the domain and origin of each module's script for the stack,
its symbols and its fonts for those registered later, it keeps
weakly, so that the SWF, its code included, goes with its last object
(some 300 KB a load of a small SWF stayed otherwise). Once a runtime
domain is collected, which its descendants' keep from happening while
they live, the compiler drops its application domain (see [Parsing, linking and verifying](compiler.md#parsing-linking-and-verifying)), and
`Code` its ABCs' hashes and the findings it told the compiler. A
collection may come hundreds of loads later, so `Code` evicts a loaded
SWF's domain from the compiler as soon as its ABCs are compiled, unless
a link is in progress in it or under it, and keeps their bytes to revive
it, with its evicted ancestors, when a SWF is loaded into it or under it;
a domain revived stays, as one loaded into again, and the root's and the
main SWF's are never evicted. After a drop or an eviction it asks the
compiler to compact when the page is next idle (`requestIdleCallback`,
else a timer), not in a load's frame. The compiler's memory then holds
the live domains' ABCs, not every ABC loaded since the last collection.
Over 8000 loads of a large application's small SWFs, none collected,
its memory stayed at the 128 MB compiling the main SWF had grown it to,
with no rebuild for the first 1600 loads and eleven in all, some 75 ms
each in node; without them it grew to 256 MB some 3000 loads on, and
to 512 MB by 8000. Each module is given only the hashes of the ABCs it
names as linked (`domainLinked`): joining every ABC's for each compile
had grown it to 256 MB by 7500 loads on its own.

That a module's code keeps its Abc has a limit: emitted code reaches `A`
only for `newclass` and `newactivation`, so a module with neither keeps
it only through its domain's globals, its scripts' entries, and not even
those if every name it defines was defined in the chain before; code of
such a module may then still run after its Abc went, and codeUrl and
codeLibrary fall back to the main SWF's. Lazy compilation keeps each
returned method's originating Abc in a WeakMap keyed by that method, so
entries built apart from their module retain their code origin even when
the body itself never reads A. The
symbols bound to names nothing defined (`Symbols.unbound`) are still
kept for good, their libraries with them.

`tests/player/leak.ts` loads SWFs over and over, by Loaders and in
players made again, and checks that the heap stays bounded, that
codegen's memory does not grow where one player loads them all, and that
a text field kept from a SWF let go still takes a font registered after
a collection.
