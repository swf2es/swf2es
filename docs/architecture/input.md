# Time and input

## Time

The player keeps a clock of its own, in milliseconds, apart from the
frame count: with `realTime: null`, `getTimer` reads it and `Timer`
fires by it, and sounds go by it always. A frame
stepped by `Player.tick()` moves the clock by one frame's duration at
the stage's frame rate, the first frame's included, so a test that steps
frames gets the same clock every time; a host playing in real time calls
`Player.advance(dt)` with the time passed, which plays frames on a grid
of the frame's duration and, without streamed audio, drops those a long
frame or a stall lost, as Flash does, rather than catch up with them as
Ruffle does. Measured in
adl at 24 fps with a 200 ms busy loop in some frames' ENTER_FRAME, Flash
runs the next frame at once after the long one, the one after at its
slot on the grid (8 to 9 ms later, 24 ms after three long frames in a
row), then 41 to 42 ms apart again: never two back to back, and the lost
frames are gone, the movie slowing down. Content that moves by the wall
clock between frames counts on that: a large real-world SWF's walk stops
when two ENTER_FRAMEs move it less than a pixel, which frames run back
to back to catch up, with no time between them, did on every hitch. So a
call runs as many frames as the host's typical interval holds, the lower
median of its last nine calls, never the current one: one, where the
SWF's frame is as long as the display's or longer, two for a 120 fps SWF
at 60 Hz, five at most; until it has seen three calls, one. A typical
interval over 36 ms is no display's (none refreshes slower than about 30
Hz) but the host lagging, often by the frames themselves, and gets one
frame a call, so that the content slows down as Flash's does rather than
feed its own lag with frames run back to back. A host that keeps time
tells `advance` how long its last call took (`busy`, which
`@swf2es/web`'s loop passes): where that came to more than a frame's
duration for each frame played, the frames overran, and the call runs
one, as Flash runs the frame after an overrun alone. Drawing is left
out of it: it costs the same however many frames a call plays, so with
it a call of one frame would look overrun where two would fit. The interval
alone cannot tell: AS2 content that holds a 60 fps movie to 30 by spinning
on `getTimer` until 33 ms after its last frame makes calls 33 to 36 ms
apart, a display's interval by time, and two frames a call then waited
66 ms every other call. What is owed beyond that
is dropped but for the part of a frame, which keeps the grid's phase;
not within half an interval of the next frame, though, where a call that
came a little early would leave a frame owed under ordinary jitter and
the next drop it. A `dt` that is not a finite positive number counts as
none. A SWF faster than the display still runs its frames back to back,
so a walk placed by the wall clock at 60 fps on a 30 Hz display can still
stop short. Streamed audio instead requests catch-up from its device
cursor: the player runs up to 60 logical frames per call, preserving
every frame's scripts and events, while the host draws only once after
that batch. A stop, seek or removal cancels the old stream's remaining
catch-up. The device cursor, rather than wall time, keeps a suspended
AudioContext from requesting frames for audio it has not played. This
applies to streams in nested clips and AVM1 content loaded by AS3 too;
event sounds keep the ordinary pacing. Extra frames get half the previous
presentation interval as a CPU budget, bounded to 8–50 ms, so sustained
render lag still leaves time for affordable timeline work. The budget and
frame-count bound make batches yield, so a long stall does not
block input indefinitely. This cannot guarantee sync when scripts alone
cannot run at the required rate. Native Flash 32,
with a 600 ms busy loop at 25 fps, ran the streamed timeline's frames
6–20 back to back, including their actions, while the equivalent
non-streamed movie resumed at ordinary pace. `advance` returns how
many frames it ran, and `Player.changes` counts what may change the
picture: each frame, each key, each call from the page into an
ExternalInterface callback, each `updateAfterEvent`, and the pointer
events that change what shows at once: a hover that moves on or off a
button or a sprite in `buttonMode`, as Ruffle redraws for, and, more
than Ruffle, any press, release or leave, which may move focus and a
caret, and a drag selecting text. A plain move does not: what its
listeners change shows at the next frame, as in Flash, so a fast mouse
draws a 24 fps SWF 24 times a second, not at the screen's rate.
An input's `updateAfterEvent` also prepares the requested redraw between
timeline frames: it dispatches `RENDER` if the stage was invalidated and
applies pending scroll rectangles. Invalidation alone requests no extra redraw;
a frame or timer that already prepared the request consumes it.
Loads and socket data are delivered in a frame. A host draws when it moved,
not on every animation frame: at 60 Hz a 24 fps SWF drew each picture
two or three times over, and drawing it once took a quarter to a third
of Chrome's CPU off 32 animated characters, the pictures alike. Frame
pacing and the clock are related but not one counter: the clock may run
on within a frame later, where the frame count cannot. `getTimer` tells
real time, as Flash's does: the whole milliseconds, truncated, since the
`Scripting` was made, by `performance.now` or the `realTime` clock a
host gives, running on while a script does, so that code timing itself
within a frame, as benchmarks and Crossbridge's C do, sees the time
pass, and a game's motion follows the time between frames. `realTime:
null` makes it tell the frame clock instead, rounded as it was, the same
on every run: the player's cases and the corpus (`tests/player/page.ts`)
and the node tests that trace it ask for that.
Timers follow the same choice. With a real clock they fire as Flash
fires them, measured in adl: in each frame right after ENTER_FRAME and
before the frame's construction, every timer due fires once, in the
order the timers were started, and next falls due its delay after it
fired, so the ticks a long frame or a stall lost are dropped, not caught
up with (a 10 ms timer fires once after a 200 ms frame, and `currentCount`
counts only the firings). A timer shorter than the frame interval also
fires between frames at its time, at most once a check; one as long as a
frame or longer waits for a frame, so a 45 or 50 ms timer at 24 fps fires
every other frame though the player checks between. In adl a 10 ms timer
fires two to four times a 24 fps frame, a 1 ms one about once a
millisecond at 1 fps; there is no floor above 1 ms, for `setInterval`
neither. Flash truncates a delay to whole milliseconds: `Timer(1000 /
24)` is 41 ms, shorter than the frame, and fired in 117 of 120 frames,
`Timer(1000 / 30)` in 150 of 150 and `Timer(1000 / 60)` in 287 of 300;
`Timer(40)` at 25 fps, the frame's length, fired in 106 of 125, and one
a millisecond longer than the frame in about 55 to 70 % (five seconds
each in adl). Our hosts check at each `advance(dt)` that plays no frame,
60 times a second for a 24 fps SWF, so a timer shorter than that fires
at each call: two or three times a frame. Their calls do not fall on the
SWF's grid, though: a 25 fps SWF's frames come 33 and 50 ms apart at 60
Hz. So the timers keep the host's time, the sum of the `dt`s it passed,
on which a frame has its exact place on the grid, the time it fell due;
a timer as long as a frame or longer is due by that, and every timer
fired in a frame next falls due from it, as does one as long as a frame
started in a frame. A timer of the frame's length then fires every
frame, however the calls fall and jitter, where adl's fired in 85 % of
them, its own frames jittering; one a millisecond longer fires every
other frame, adl's in 55 to 70 %. A short one is due in a frame by the
call's time, less a frame for each the call plays after it, so that a
frame run late does not hold it back, and a SWF faster than the display
fires it in each of its frames, not once a call; between frames it also
waits its whole delay since it last fired, the least interval adl showed.
At 60 Hz the checks come every 16.7 ms where Flash's come every few, so a
timer shorter than that fires two or three times a 24 fps frame where
adl's fired two to four, and a 20 ms one each 33 ms between frames where
Flash's fired each 20 to 25. The host's time follows the `dt`s it
passes, not the real clock, which only places it at the first call and
tells the time between calls. `updateAfterEvent` in a timer
fired between frames has the stage render then, with RENDER if a script
invalidated it, as Flash does; an invalidation without it waits for the
frame. Ruffle fires its timers after the frame from the same real clock
but catches missed ticks up, ten at most a call, clamps delays to 10 ms
and fires long timers between frames too. With `realTime: null` timers
fire by the frame clock: a frame moves it on and every due time in it
fires, at the same point after ENTER_FRAME, the same on every run, which
the cases and the corpus's `timer*` tests rely on.

`flash.utils.Timer` is playerglobal's own in all but three natives: the
counting, `delay`'s range (RangeError #2066), `reset` and the events are
AS3; the player keeps the timers started (`scripting/timers.ts`, with
the clocks), each with its delay and the closure to call, fires the ones
due as above (by the frame clock, each firing the earliest due so that
two timers interleave as their times do, two due at once in the order
scheduled), and tells `running`. The timers are a heap by due time, as
asyncio keeps its callbacks: a scan of all of them per firing costs
2.5 ms a frame at a thousand timers where the heap costs 0.3, and
nothing either way below a hundred.
Flash fires timers between frames at their own times, so by the frame
clock, while a timer's closure runs the time is the one it fell due at,
which a timer started from it counts from and `getTimer` tells: three
timers set one from another at 100 ms each land at 400, 500 and 600 ms,
as in Flash, not a frame later each (the corpus's `timer_finished`).
`setTimeout` and `setInterval` are AS3 over `Timer`. The corpus's
`timer*` tests, Flash's traces of timers against frames, are the
reference by the frame clock, with node tests of the real clock's
passes against an injected clock (`tests/unit/player/scripting/timers.test.ts`).

## The pointer

`MouseEvent` keeps its local coordinates and flags on the event. Its stage
coordinates are read through the target's current display matrix, so moving
the target after dispatch changes them without changing `localX` or `localY`.
Without a target a finite local coordinate gives stage coordinate zero, and
an unset one stays NaN (`mouseevent_constr` and `mouseevent_stagexy` in the
corpus). AIR's `playerglobal.abc` adds `commandKey`, `controlKey` and
`clickCount` to `MouseEvent.toString`; the Flash Player trace in
`mouseevent_valueof_tostring` has none of them, so that one output still
differs though its native values match.

`RenderView.bindPointer(player)` (`scene/pointer.ts`) takes the pointer's
position on the canvas from the browser's pointer events,
scaled to the SWF's stage, within the box CSS `object-fit` shows the
canvas's pixels in (`contain`, `scale-down`, `cover` or `none`, centred as
the default `object-position` has it, inside borders and padding), and
passes it to the
player's own hit test. It shows the cursor the player chooses, as Ruffle
does: a hand over a button that uses one, disabled or not, or under the
nearest sprite in `buttonMode` whose `useHandCursor` and `enabled` are
true, and an I-beam over selectable text; a link in text shows no hand
yet. That is `Mouse.cursor`'s `"auto"`; `"arrow"`, `"button"`, `"ibeam"`
and `"hand"` force CSS `default`, `pointer`, `text` and `grab` over
the whole stage (`"hand"` is Flash's dragging hand, as Ruffle shows it),
and any other name is ArgumentError 2008, as in Flash. `Mouse.hide()`
makes it none over the stage, at once, wherever a script calls it, even
over a forced one, and `Mouse.show()` brings back the one it hid; the
pointer still picks its targets while it is hidden, as in Flash and
Ruffle. `Mouse.registerCursor`
checks its `MouseCursorData` as Flash does (frames of at most 32 by 32,
a hot spot within 0 to 31) and makes the first frame a PNG `data:` URL,
with no DOM, that `Mouse.cursor` can then name before Flash's own names;
CSS cursors do not animate, so a cursor of several frames shows its
first. `supportsCursor` and `supportsNativeCursor` are true, as in
desktop Flash.
The display list decides the target, so masks, scroll rectangles, depth,
visibility, `mouseEnabled` and `mouseChildren` use the same objects that
scripts see; the renderer does not choose a Flash target. The
pointer sends `mouseOver`, `mouseOut`, `rollOver`, `rollOut`, `mouseMove`,
`mouseDown`, `mouseUp`, `click` and `doubleClick` through EventDispatcher's capture and
bubble phases, and the stage's `mouseLeave`, in the order Flash Player 32
traced them (a probe logging every event with its target, run in
Electron's PepperFlash and driven over the DevTools protocol, the
`MouseOrder` test of `tests/unit/player/input/pointer.test.ts`): a
pointer at a new point sends `mouseMove` to what is under it first, then
moves the hover, `mouseOut` and the `rollOut`s from what it was over up to
the common ancestor, the `rollOver`s from the new object up, then
`mouseOver`. A press or a release at a new point is that move, with
`buttonDown` as it was before, then the press or release; one where the
pointer already was is its own events, then any hover that changed. A
move to where the pointer is sends nothing. The empty stage takes
`mouseMove`, `mouseDown`, `mouseUp` and `click`, but nothing is over it:
leaving an object for it is a `mouseOut` whose `relatedObject` is null,
and no `mouseOver`. The pointer leaving the player with its button up is
`mouseOut` and `rollOut`s at the stage point (-1, -1), though `mouseX`
and `mouseY` stay where they were, then `mouseLeave`. With the button
down after a press on the player, the mouse stays its own, as Flash's
plug-in kept it: no leave, the moves outside go to the stage, and so
does the release, and the leave comes at the next move outside after it.
A leave is sent once until the pointer is back, so a right button's
release outside, which holds nothing, leaves no second time; a left
button let go where the host told of no release (outside the browser, or
while another button stays down, which Chrome tells as a move) is
released at the next move that shows it, and left where that is outside.
`updateAfterEvent` changes none of this. The second click of a double
is a `doubleClick` in the click's place where the target's own
`doubleClickEnabled` is true, its parent's counting for nothing, and a
third a click again, as Flash Player 32 traced them. The plug-in took the
browser's count of clicks, and counted none whose first was on another
object; the player counts a press on the last one's target within half a
second and two pixels of it, Ruffle's rule, as the browser's own would.
Ruffle sends
`mouseMove` first too, and no `mouseLeave`.
A mouse that stands still is picked for again at each frame's end, after
its `exitFrame` and before its `render`, as Flash Player 32 does: an
object a script moves, hides, disables or takes off the list from under
it gets its outs, one that comes under it its overs, with no
`mouseMove`, and the cursor follows. One taken off the list hears no
`mouseOut`, only the `rollOut`s of the ancestors it had when the hover
came, the root's too, as Flash sends them. Flash notices an object moved
in under the mouse a frame later than one moved out (its pick seems to
go by where the last render drew it); the player notices both at once.
Nor does Flash notice a text field that shrinks out from under a still
mouse until the mouse next moves; the player sends its outs at the
frame's end, as for any other object.
The pick runs only when something a pick reads changed since the last
(`pickWork`: whatever invalidates an object, and `mouseEnabled`,
`mouseChildren`, a `hitArea` or a button's `enabled`), so a still scene
costs nothing, and a busy one a pick a frame, what one mouse move costs.
The pick carries the point down the list into each object's space, making
no matrix per object, and passes over a container whose bounds miss it:
bounds each object keeps in its own space (`pickBounds`), marked stale by
a change in it or under it, and not by its own move, which only its
ancestors' bounds see. They are worked out only for what stood still over
the last two picks, as what changes on most frames costs less gone
through than measured; a timeline shape is checked against its recorded
bounds before its fills. A button's hit test state is in no container,
so a button and those above it are measured each time, as is a sprite
with a `hitArea`, which may be anywhere on the list, its bounds taken
through the stage into the sprite's. A NaN in bounds, from a NaN or
infinite matrix or an infinite drawing, rules no point out.
On 400 rigs of 12 moving parts (10,000 objects), a pick takes 0.01 ms
where it took 0.5 ms and 125 KB, and
`tests/player/bench.ts --scripted 400 --still --hover` ticks as without a
mouse over the stage, 0.3 to 0.4 ms, where it took 0.8; where every part
is new each frame, a pick after a tick takes 0.2 to 0.3 ms, against 0.7.
`DisplayObject.mouseX` and `mouseY` follow the last pointer position.
The pick follows Flash's order, as Ruffle's `mouse_pick_avm2` has it:
interactive children before artwork, and a hit on what takes no pointer
goes up only once nothing else under the point has taken it, to the
nearest ancestor whose `mouseEnabled` is true, past any number that are
false. The main SWF's root is never the target, as Flash Player 32
traced it (the `MouseGaps` probe of the same test file): its own art, a
hit passed up to it, and all of it with its `mouseChildren` false go to
the stage, while it stays over as an ancestor; a sprite a script puts on
the stage beside it takes its hits as any other; a loaded SWF's root a
script puts on the stage itself is taken for the main root, which no
probe has measured. What a
mask, a scroll rect or a timeline's mask layer hides takes no pointer
(`mouse_pick_masking`): a list scrolled under a mask layer is clicked
only where it shows. `hitTestPoint` asks no mask layer above the object
it tests, as Flash's does not (the corpus's `from_shumway/hittesting`:
a point a layer hides still hits), and `getObjectsUnderPoint` none
either. A move is
posted rather than handled at once, and the player handles the last one
posted when it next advances, or before the next press, release, leave
or key, whichever comes first: a browser sends about one a frame, a
headless one or a fast mouse more, and each picks from the whole list.
A pointer that crosses a small object between two frames so sends it no
`mouseOver`. A path's polygon, flattened for hit tests, is kept with it.
A sprite with a `hitArea` is hit where the area draws, wherever the area
is on the display list and shown or not, and not by its own drawing; its
interactive children still pick unless its `mouseChildren` is false, and
an area off the list hits nothing. Ruffle stores AVM2's `hitArea` and
picks without it. adl leaves the area's own `mouseEnabled` as it was
(`sprite-hit-area`), so a shown, enabled area on top takes the pointer
itself, as Flash's documentation warns; `hitTestPoint` and
`getObjectsUnderPoint` ignore it. A drag keeps, as it moves and when it
ends, the topmost object drawn under the pointer outside the dragged
sprite, which `dropTarget` reads: the shape, not the sprite that takes
the pointer, as Flash's trace of the corpus's `sprite_dropTarget` names
the shapes in its sprites, and null over nothing. Neither can be played
in adl, which the harness gives no pointer, so the unit tests carry them.
The wheel sends `mouseWheel` to what is under the pointer, bubbling and
not cancelable, its `delta` lines up positive, and a text field there
whose `mouseWheelEnabled` is true then scrolls by as many lines, as the
corpus's `mouse_wheel_events` has Flash trace them (its `scroll` event is
not sent yet). PepperFlash on Linux, the Flash Player 32 at hand, gave no
`mouseWheel` at all for the DevTools protocol's wheel, and let the page
scroll under it; Adobe documents the delta as the lines a notch
scrolls, 3 by Windows' default, as Ruffle's own tests send it. The host makes a browser's notch 3 lines, whether it gives 3 lines
or about 100 pixels (fewer on a zoomed page or a scaled screen, a
multiple for notches run together), and adds a touchpad's pixels up, 100
to 3 lines, sending nothing for a part of one. That is untried on
macOS, whose wheels and touchpads give pixels of their own measure. It keeps the page from
scrolling only where the SWF takes the wheel: a `mouseWheel` listener on
the target or an ancestor, or a field that can scroll; elsewhere the page
has it. With Ctrl, as a touchpad's pinch comes too, the page zooms and the
SWF hears nothing. Right and middle buttons, and
Flash's drag and focus rules, still need their own cases.

## Touch

`Multitouch` reports the host's touch screen: `maxTouchPoints` is the
browser's `navigator.maxTouchPoints` (or the `maxTouchPoints` a host gives
`Scripting`), `supportsTouchEvents` whether it is above zero, and
`Capabilities.touchscreenType` `"finger"` then, `"none"` otherwise.
Without a touch screen, adl and Flash Player 32 both start `inputMode`
at `"none"` and keep it there whatever a script sets, after checking the
value (TypeError #2007 for null, ArgumentError #2008 for a name not
MultitouchInputMode's), and the player does the same (the `touch-natives`
case); with one, it starts at `"gesture"`, as Adobe's reference has
Flash start, and takes every mode. No gesture is recognized:
`supportsGestureEvents` is false and `supportedGestures` null, so gesture
mode leaves touches to the mouse, and scripts can only make and dispatch
the gesture events themselves.

`bindPointer` sends the pointer events whose `pointerType` is `"touch"`
to `input/touch.ts`; a pen is a mouse. The browser's primary touch, the
first finger down while none was, moves the mouse, in every mode, as
Flash's plug-in did (AIR's `mapTouchToMouse`, true by default, turns
that off in touchPoint mode): a press is a move to the point, where the
mouse was elsewhere, and a press, as Flash Player 32 handled a browser's
emulated touch, then moves, then a release, which clicks as a mouse's
does; the lifted finger leaves the mouse where it was, with no rollOut.
In touchPoint mode every touch is TouchEvents too, picked as the pointer
picks and in the mouse's order: a move's `touchMove`, then `touchOut` and
`touchRollOut` from what the point was over and `touchRollOver` and
`touchOver` on what it is over (none on the empty stage); for a begin
the hover, then `touchBegin`; for an end `touchEnd`, a `touchTap` where
it ends on the object it began on, and, once lifted, `touchOut` and
`touchRollOut`, as a lifted finger is over nothing. `touchPointID` is the pointerId, the
local point is the target's, `sizeX` and `sizeY` the contact's size in
stage units and `pressure` the browser's. Each step's touch events come
before the mouse events of the same step. A point's moves are posted as
the pointer's are, the last of each point handled at the next flush. A
touch the browser cancels ends where it last was, with a `touchEnd` whose
AIR `isTouchPointCanceled` is true but no `touchTap`, and its mouse with
`mouseUp` but no click; a pointer id that begins again before its end
came first takes the old point out of what it was over and lets its
mouse go, without a click. Each step reads `inputMode` and
`mapTouchToMouse` as they are then, so a change in the middle of a touch
applies from its next step: a touch begun in gesture mode may end with
touch events and no begin, and one begun in touchPoint mode with none.
What Flash did there is not known. A touch's begin, end and tap are a
user's gesture for the clipboard, as a press is; the browser itself
counts only a touch's release as the user's activation, so a write in
`touchBegin`, or in the `mouseDown` a touch makes, may be refused by its
async API. The canvas keeps `touch-action: none` while bound, whatever the
mode: Flash's plug-in took every touch on it, and a
SWF that drags with the mouse needs it, as a page that scrolled under the
finger would cancel the drag. None of the order between touch and mouse
events could be measured: adl under Wine and Flash Player 32 on Linux
report no touch screen and dispatch no TouchEvent. The order is the
reference's ("the first point of contact dispatches a mouse event and a
touch event") and the W3C's, touch first; Ruffle dispatches no
TouchEvent. Nor could the TouchEvents' own order: a move before its hover
is the mouse's, measured, taken over.

## Keyboard and focus

A host gives the player its keys (`bindKeyboard`, `input/keyboard.ts`): each
goes to `stage.focus`, or the stage where nothing has focus, as a
`KeyboardEvent` that bubbles, the browser's legacy key code standing for
Flash's, which it matches. A focused input field then edits with it, in
Ruffle's order: a `TextEvent.TEXT_INPUT` with the character as typed,
which a listener may cancel, then `restrict` and `maxChars` filter it,
it goes in at the caret, over the selection, and `Event.CHANGE` follows.
Backspace, Delete, the arrows, Home and End move and delete, Up and Down
by a line, Shift extends the selection, Ctrl+A selects all (Ctrl with
Alt is AltGr, and types), and Enter adds a line only to a multiline
field. A press in a selectable field puts its caret at the nearer side
of the character pressed, and a drag from there selects, by words after
a double click and by lines after a triple click, as Ruffle's does (two
presses within half a second and two pixels make a double). A click
gives focus to any text field and to whatever Tab may focus, and a click
on anything else takes focus from what Tab may focus, after a cancelable
`mouseFocusChange` on what had it. Tab may focus input fields, buttons
and sprites in `buttonMode` unless `tabEnabled` says otherwise, not a
timeline on the stage itself, and nothing inside a container whose
`tabChildren` is false; it moves by `tabIndex` where any has one, else
by where each starts on the stage, after a cancelable `keyFocusChange`.
`stage.focus` set by a script moves focus too, and every move is a
`focusOut` and a `focusIn`, each naming the other. An object taken off
the list or hidden loses focus. A focused field draws its caret,
unblinking, a pixel wide in the colour of the text before it, and its
selection shaded, line by line, both clipped to the lines shown; a
focused selectable dynamic field shows its selection too. A key the
player used, an edit or a caret moved in a field or a Tab that moved
focus, the host keeps from the browser; any other, a game's arrows say,
still reaches the page too, which may scroll by it. A focused selectable
field that takes no typing moves its caret and selection with the same
keys, and selects all with Ctrl+A. adl cannot be typed into, so none of
this is recorded against Flash; there is no IME, and no scrolling to
keep the caret in view.

A key's release goes elsewhere when the page or the window loses focus
while it is held, and never reaches the player. The host tells the
player its focus (`Player.setActive`, bound by `bindActivation`,
`input/activation.ts`): the window's blur and focus, the document's
visibility, and the element's focus moving to the page around it, as a
plug-in lost focus to its page. A page without focus or hidden as the
host binds starts the player inactive, before its scripts listen, so
its first focus is an `ACTIVATE`. Losing focus, the player lets go of
the keys AVM1's `Key` holds with no keyUp: Flash sends none then, which
is why content clears its own keys on `Event.DEACTIVATE`, and a release
the user never made could set off a game's action. The mouse's buttons
stay the pointer's, which finds a release it missed at its next move.
It then broadcasts `deactivate`, and gaining focus back `activate`, to
every EventDispatcher that listens, display object or not, as Adobe
documents them, at the target alone. Unlike a frame's broadcasts, these
listeners are held weakly (`WeakTargets`, `scripting/events.ts`): a
listener for them keeps no object alive and no orphan playing. A change
applies once the JavaScript that told it has returned, or at the next
frame: the page may move its focus inside an ExternalInterface call,
and no listener runs inside another script. Only the last state told
counts, so a blur and a focus together send nothing. A host that never
calls it leaves the player active.

## Context menus

`Player.contextMenu` snapshots an AVM2 menu on demand, using the input
hit test and the nearest ancestor with a `ContextMenu`. Root artwork
targets the root for menus, as Flash Player 32 does. `menuSelect` runs
before the custom items are read, so its listeners can replace items or
change their captions, visibility and enabled state. A selection sends
`menuItemSelect` to the captured item, with the original `mouseTarget`
and `contextMenuOwner`, in a clipboard gesture. Later item changes do
not rewrite a menu already open. Destruction makes its callbacks inert.

`scene/context-menu.ts`, bound with the pointer, presents the snapshot
in a DOM popover shared by the web element and desktop player. Captions
are text, never markup. Only an open menu holds DOM nodes and document
listeners; closing, blur, outside focus, resize or unbinding releases
them. The top layer escapes a web element's overflow and works in full
screen. Arrow keys, Home, End, Enter, Escape and Tab navigate or dismiss
the menu; the popup takes those keys before the SWF does. An embedder
can capture and prevent the canvas's `contextmenu` event to provide its own UI.

The first implementation supports AVM2 custom items, separators,
visibility, disabled items, quality actions and an About entry.
`ContextMenu.isSupported` is true. `Stage.showDefaultContextMenu`,
the web element's `menu="false"`, and `hideBuiltInItems` control
built-in quality entries while keeping custom entries. AVM1 custom
menus, programmatic `ContextMenu.display`, AIR menu trees and the
other Flash built-in actions remain unimplemented. The model is
renderer-independent so those can reuse the presentation.

## The clipboard

Flash Player 10 let a script write the clipboard only while it handled
a user's event, a key, a mouse button, a copy or a cut, and read it only
while it handled a paste, as the
[Clipboard reference](https://help.adobe.com/en_US/FlashPlatform/reference/actionscript/3/flash/desktop/Clipboard.html)
and the
[developer's guide](https://help.adobe.com/en_US/as3/dev/WS2F6A31B9-1AE6-4b23-9C12-57A33F4F0516.html)
tell; the player keeps those rules in `scripting/clipboard.ts`, which
holds the clipboard by Flash's native format names (`air:text`,
`air:html`, `air:rtf`, `air:url`, and a script's own formats as
`air:reference:` and `air:serialization:` entries). The pointer's
presses and releases, a touch's begin, end and tap, and every key run as a gesture, in which
`canWriteContents` is true; a paste runs as one in which
`canReadContents` is too. playerglobal's AS3 checks both and throws its
SecurityErrors; the natives (`playerglobal/flash/desktop/Clipboard.ts`)
store and give back, run a `setDataHandler` handler when its format is
first read, and refuse `new Clipboard()` with IllegalOperationError
#2178, Flash Player having the system's alone. `clear` and `clearData`
outside a gesture throw SecurityError #2191, and `System.setClipboard`
Error #2176, as Ruffle has the plug-in throw it; a null string is
TypeError #2007. Bitmaps and files are AIR's, and are not kept.

The keys go through the text field with focus, as Ruffle's
`text_control_input` has them: Ctrl+C copies its selection, but not a
password's; Ctrl+X does so and deletes it, in an input field only, with
Event.CHANGE; Ctrl+V types the clipboard's text into an input field as
if typed, a TextEvent first that a listener may cancel, then `restrict`
and `maxChars`, its line breaks as `"\r"` in a multiline field and
dropped from a single-line one, with every other control character,
and nothing at all from an empty clipboard. A TextField dispatches no
Event.COPY, CUT, PASTE or SELECT_ALL, Flash's reference says; any other
object with focus hears them for the same keys, PASTE bubbling as in
Flash Player and the others not, and writes or reads the clipboard in
them. With nothing in focus, none is heard, and Ctrl+A is the page's.

The browser's own copy, cut and paste events carry the data both ways:
`bindKeyboard` lets Ctrl+C, X and V through to the browser, which sends
the focused element the event, and the player answers it at once, the
copy's data set on the event and the paste's read from it, which needs
no permission. A script's write in any other gesture, a click's
`System.setClipboard` say, goes to the host's `ClipboardHost`, by
default the async Clipboard API's `writeText`, or `write` with HTML,
which a browser allows during a user's activation; null in node, where
the clipboard is the player's memory alone and a paste without the
host's data pastes what the SWF last copied. Nothing reads the system's
clipboard but a paste, as in Flash. The context menu's built-in Cut,
Copy, Paste, Delete and Select All are not implemented yet; a paste
from the popup would need the async API's `readText`, which asks the
user's leave. `tests/web` presses the keys in Chrome.
