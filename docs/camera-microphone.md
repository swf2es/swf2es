# Camera and microphone

The player supports AS3 camera capture, live Video rendering, microphone samples
and loopback through an optional capture host. Browser and desktop hosts use
Chromium media APIs; node and hand-stepped tests can omit or substitute the host.

## Scope

Without a capture host, `flash.media.Camera` and `Microphone` behave as Flash Player does on
a machine with neither (`packages/player/src/playerglobal/flash/media/`):
supported, no names, `getCamera()` and `getMicrophone()` null. Without a source, `Video`
draws an empty box (`packages/player/src/display/videoobject.ts`). Real
content uses them: webcam toys and photo booths, voice recorders, games
played by blowing into the microphone, video chat front ends. None of the
corpus does, so this is for content, not for the score.

The hosts use browser APIs available in Chromium: `getUserMedia`,
`enumerateDevices`, AudioWorklet, and WebGL texture uploads from a video
element. No native package and no codec is needed: the
codecs Flash had for these (Nellymoser, Speex, Sorenson, H.264 encoding)
only served publishing over RTMP, which is out of scope (section 7).

## 1. What Flash does

From Adobe's documentation; adl on Linux sees no devices, so behaviour
with a device present is not measured, and each point below is to be
confirmed where a machine with Flash and a camera allows.

- `Camera.names` lists the devices; `getCamera(name)` takes an index as a
  string (`"0"`), null or omitted for the default. A new `Camera` is
  `muted` until the user allows it; Flash asked, in its privacy dialog,
  when a camera was first attached to a `Video` or a `NetStream`, and
  dispatched `StatusEvent` with code `"Camera.Unmuted"` or
  `"Camera.Muted"`. Its settings: `setMode(width, height, fps,
  favorArea)` (default 160×120 at 15 fps), `setMotionLevel(level,
  timeout)` (50 and 2000 ms) with `activityLevel` and `ActivityEvent`,
  `setQuality`, `setKeyFrameInterval`, `setLoopback`; read-only `width`,
  `height`, `fps`, `currentFPS`, `index`, `name`. Flash Player 11.4 added
  `copyToByteArray`, `copyToVector` and `drawToBitmapData`.
- `Microphone` the same way (`"Microphone.Unmuted"`, `"Microphone.Muted"`):
  `rate` of 5, 8, 11, 16, 22 or 44 kHz (8 by default), `gain` 0–100,
  `setSilenceLevel(level, timeout)` (10 and 2000 ms) with `activityLevel`,
  `setLoopBack`, `setUseEchoSuppression`, and from 10.1 the
  `sampleData` event: a `SampleDataEvent` whose `data` holds the captured
  samples as 32-bit floats, mono, at `rate`. `getEnhancedMicrophone` adds
  echo cancellation and noise suppression.
- In AIR there is no privacy dialog: `Camera.permissionStatus`,
  `requestPermission()` and `PermissionEvent` (the same on `Microphone`)
  stand for the operating system's consent.
- `BitmapData.draw(video)` copies the frame a `Video` shows.

## 2. A capture host

A host interface in `packages/player/src/hosts.ts`, as the socket host
is: devices listed, a capture opened with constraints, its frames and its
samples delivered, its state (granted, denied, ended or unavailable) reported, and stopped.
The player never calls a browser API itself, so node and the tests can
leave it out or supply deterministic test devices.

The browser implementation lives in `@swf2es/player-hosts`:
`getUserMedia({ video })` or `({ audio })` with the constraints
`setMode` and `getEnhancedMicrophone` ask for (`width`, `height`,
`frameRate`, `echoCancellation`, `noiseSuppression`), and
`enumerateDevices` for the names, whose labels Chromium gives only once
permission is granted. The desktop page uses the same implementation; it
differs only in who answers the permission (section 6).

## 3. Live video in the renderer

A `VideoSource` carries the current host picture. The browser camera publishes a
video element from `requestVideoFrameCallback`; it does not use
`MediaStreamTrackProcessor`. The renderer uploads a changed image with `texImage2D`
or, at unchanged dimensions, `texSubImage2D`, and draws the Video's box as a
textured quad with its transform, colour transform, filters and smoothing.
Unchanged frames are not uploaded again. The source interface can also carry a
host-owned canvas or VideoFrame; NetStream playback remains unimplemented.

Plain `BitmapData.draw(video)` and the camera's copies read the frame on
the CPU (`drawImage` into an `OffscreenCanvas` and `getImageData`). Copies
with effects use the renderer as explained below; GPU readback can stall
(docs/cpu-raster.md).

The renderer implementation uses a host-owned `VideoSource` published
only when a new picture arrives. Each view uploads that source once per
published frame, shared by its attached Videos. The source keeps the
current image valid until replaced, so it can be uploaded again after a
lost context. Publishing also invalidates the Videos' ancestors, including
cached filter outputs. A source can publish null when capture ends.

The image uploads directly through WebGL's image overload; the renderer's
core carries it as an opaque object and keeps its DOM-free boundary.
CPU pixels are read synchronously from the source's `readPixels` callback
and cached for that published frame. A browser host can implement that
callback with an OffscreenCanvas; asynchronous `VideoFrame.copyTo` would
need to finish before a synchronous AS3 copy. Plain
`BitmapData.draw(video)` uses the CPU compositor, including its matrix,
colour transform, clip and blend mode, even without a renderer. Drawing
a container that contains a Video still uses the existing display-list
renderer. A direct Video copy with filters, a mask or a scroll rectangle
also uses that renderer to preserve their order and coordinate spaces;
its final composited pixels may be read back. This is an explicit exception
to the initial no-readback goal, agreed during implementation: plain copies
avoid that cost, while copies with effects have the same synchronization
cost as other display-object copies. The source image itself is uploaded
directly, without reading back the camera texture.

An adl probe using a generated Sorenson FLV through `NetStream.appendBytes`
confirmed that direct Video copies apply their own scroll rectangle,
colour-matrix filter and mask. This observation needs no capture device.

A second generated-FLV probe found that direct copies use `Video.smoothing`,
ignoring `BitmapData.draw`'s smoothing argument, and that `NetStream.close()` keeps
the last image. Camera detach likewise keeps an independent still image until
`Video.clear()` or another attachment; this camera behavior is inferred, since adl
has no camera. The browser snapshots once on detach, and does not keep the device
open to retain the picture. Custom live-image hosts provide `VideoPicture.retain`
to keep an independent GPU image as well as CPU pixels; without it, detach clears
the Video. An unreferenced Video ends capture without a snapshot.
CPU copies reuse their pixel store at unchanged dimensions and skip premultiplication
for opaque camera frames. WebGL similarly reuses same-size texture storage and drops
an invalid host picture without blocking other uploads.

`Video.clear()` hides the current picture until the source publishes
another frame, without stopping the source. This follows
[Adobe's Video documentation](https://airsdk.dev/reference/actionscript/3.0/flash/media/Video.html#clear()),
not a device observation under adl. The generated-canvas test covers
frame orientation, sharing, resizing, smoothing, colour transforms,
cached filters, CPU copies and context restoration. Existing Flash cases
continue to cover Video without a source.

## 4. Camera

The AS3 natives expose devices behind the existing surface: `names`
from the host, `getCamera` a `Camera` bound to one device, `muted` until
the host says granted, status changes,
`width`/`height`/`fps`/`currentFPS` from the track's settings, and the
motion detector: the mean difference of consecutive frames, sampled small,
against `motionLevel`, raising activity on motion and ending it after
`motionTimeout` without motion. The
11.4 copies go through the CPU frame of section 3.

Status events report the first consent result and subsequent changes. Reopening an
already permitted device does not repeat `Unmuted`; Stop and attribute revocation
report `Muted` to devices that were opened or told of a decision, and nothing to
devices the movie never opened. `sampleData` never precedes `Microphone.Unmuted`:
samples captured before the frame that reports the grant wait, bounded by the queue. AIR permission requests after revocation answer `denied` while the
player remains alive. Without a capture host, both static permission getters report
`granted`, as measured in Linux adl; this does not imply that devices exist.

Only browser permission/security failures count as denial. Stale device constraints
are retried once with preferences; other opening failures (in the desktop shell too)
report a `Camera.Unavailable` or `Microphone.Unavailable` status without changing
consent. These asynchronous device-error notifications are a host extension, not
measured Flash behavior. Adobe's
[getEnhancedMicrophone](https://airsdk.dev/reference/actionscript/3.0/flash/media/Microphone.html#getEnhancedMicrophone())
documents `Microphone.Unavailable` for the other microphones, which stop providing
audio, but no level; it is sent at level `"status"`, as every other capture code,
and only to microphones that were capturing. An unavailable device can be retried by attaching again.

The browser host enumerates, and reads the permission states, before the
code of the first SWF that names `flash.media.Camera` or `Microphone` runs
(its ABCs' constant pools, or the full name as a string, as
`getDefinitionByName` takes it), so synchronous `names` and `getCamera`
can use the result without prompting. A SWF loaded later that names them
waits for it the same way. A SWF that never names them pays nothing: a
browser's first enumeration added about 140 ms to a cold start. The
reading overlaps the SWF's compiling and linking, which run none of its
code. A SWF that reaches the classes only by a name built at run time is
not seen: its first call to `names`, `getCamera`, `getMicrophone` or
`isSupported` finds no devices but starts the reading, and later calls
find them. It opens capture only
on attach, with ideal size/aspect-ratio/rate constraints, then reports
actual track settings. `favorArea` prioritizes the requested size by
capping frame rate; Chromium's native-mode selection cannot reproduce
Flash's device-driver selection exactly. `setQuality`, keyframes and
loopback keep settings but do not encode local video, since publishing
and compression are out of scope.

Camera identity and activity defaults follow
[Adobe's Camera reference](https://airsdk.dev/reference/actionscript/3.0/flash/media/Camera.html):
repeated requests for an index share one Camera, and an unattached
camera has activity -1. As the Video reference specifies, attaching that
Camera to another Video transfers the attachment. Capture starts on
attach with browser consent; no extra gesture gate is added. Until the
first permitted frame the Video is empty. These device rules are
documented, not measured with adl. Activity uses mean luminance change
on 32×24 samples, only while an activity listener is present and motionLevel is
below 100. Buffers are reused. The scale is `min(100, 100 * sqrt(8 * meanChange / 255))`,
so a mean change of 3.125% reaches level 50. This is a documented approximation to
Flash's unpublished detector, not a measured device curve. `currentFPS` averages
about one second of frame timestamps, caps bursts at the negotiated rate, and falls
to zero when frames stop.

`allowcapture="false"` and `configure({ allowCapture: false })` refuse
capture. Revoking the attribute aborts captures for that load; enabling
it again requires reloading. The capture host's signal also closes tracks
when permission resolves after the player has already been destroyed.

## 5. Microphone

An AudioWorklet on a `MediaStreamSource` hands blocks of samples to the
player, which resamples them from the device's rate down to `rate` and
dispatches `sampleData` on
movie frames or between them, at most about 100 ms apart while the host runs.
Worklet-message delivery also drains the queue when hidden-page timers are throttled;
a hand-stepped host without a real clock keeps frame-driven delivery. `activityLevel` is the block's RMS on
Flash's 0–100 scale against `silenceLevel` and its timeout; `gain` is a
gain node before the worklet; `setLoopBack` routes the input to the
player's own output. Chromium's autoplay policy applies: active capture itself
can permit Web Audio playback, so loopback does not impose an additional gesture
gate ([Chrome's policy](https://developer.chrome.com/blog/web-audio-autoplay)).

The implementation starts capture when a `sampleData` listener or loopback
needs it, and closes capture when neither remains. Loopback without an output
host does not open a microphone. `Loader.unloadAndStop` releases the loaded movie's
capture consumers while other movies' listeners remain; loopback stays on while any
movie that turned it on is still loaded. Device defaults, status
codes and enhanced-device exclusivity follow [Adobe's Microphone reference](https://airsdk.dev/reference/actionscript/3.0/flash/media/Microphone.html),
not device observations under adl. Without a host the existing defaults
and null getters are unchanged.

The worklet mixes to mono and sends 2048-sample blocks after gain (50 is
unity). Eight reusable transfer buffers allow about 340 ms of outstanding audio at 48 kHz,
plus the block being filled; a longer main-thread suspension drops blocks to keep
memory bounded. The player
uses a 96-tap windowed-sinc low-pass converter with continuous phase and
history, including 48 kHz devices and the 16 kHz rate. The 5/11/22/44 modes
use the 44.1 kHz family (5512.5/11025/22050/44100 Hz); 8/16 use 8000/16000 Hz.
Activity uses clipped PCM RMS, an approximation to Flash's unpublished
meter. Audio and activity events are bounded while SWF frames are paused.
The resampler reuses its input/history and lends output to the fixed 16384-sample
queue; script-owned ByteArrays and output-host-owned loopback blocks remain independent.
A rate change discards pending old-rate data rather than mixing rates in
one event. Sample positions count produced samples, including discarded
ones. Loopback is bounded to about 200 ms of pending audio and goes through
the existing output host and SoundTransform, subject to browser autoplay policy.

Enhanced capture requests Chromium's native echo cancellation and noise
suppression; those are best effort, not Flash's proprietary DSP. Codec and
encoder knobs retain their values without implementing network encoding.
Chrome fake-tone tests cover all six rates, permission denial and cleanup;
unit tests also check attenuation above Nyquist, block boundaries, gain
settings, activity, rate changes, and loopback limits. A CDN test loads the
worklet through the bundled distribution under its documented CSP.

## 6. Permission

A capture is never started without the user's yes.

- In the browser, the browser's own prompt is it. The page must be a
  secure context; a page that embeds the player in an iframe must allow
  `camera` and `microphone`. The `<swf2es-player>` element accepts
  `allowcapture="false"`, and `configure` accepts `allowCapture: false`,
  to refuse captures outright.
- In the desktop app, the session's permission handlers allow full screen
  and let `media` through only after a dialog of the app's own that names the
  top-level movie's source and the device kind (camera or microphone). On macOS
  the app also asks the system
  (`systemPreferences.askForMediaAccess`). While a device is live the
  window's title says so and a menu item stops it; a page that ends
  stops its tracks. Answers are scoped to the current movie load.
- For an AIR application, `permissionStatus` and `requestPermission()`
  are answered by the same dialog, and `PermissionEvent` follows.

The desktop implementation asks before forwarding a capture to Chromium,
scoping its answer to the movie and page lifetime rather than the shared
`swf2es://app` origin. Its dialog names the movie's source and camera or
microphone, not a physical device label. Requests from loaded child SWFs are
attributed to that top-level movie. Movie names and source text are sanitized and
bounded for the dialog. macOS also uses Electron's system-consent API. The request and
check handlers reject capture without that decision and outside the app’s main
frame. Mixed camera/microphone requests need both decisions. Answers are not saved
across loads. Permission-status reads are cached in the preload per movie epoch,
updated by permission results and Stop; polling does not perform synchronous IPC
after the first read for each kind. AIR's static `permissionStatus`, instance
`requestPermission`
and `PermissionEvent` use this same host policy; the new members are hidden
from browser API versions. The standalone permission classes live in the
AIR library. Their constants, event defaults and cloning follow
[Adobe’s permission API](https://airsdk.dev/reference/actionscript/3.0/flash/events/PermissionEvent.html)
and are checked against adl without using a device.

The title marker and Stop Camera and Microphone menu include initialization
while a microphone worklet loads. Stop waits for confirmation that tracks
have stopped, including streams returned after an aborted permission request.
The shell probes renderer responsiveness every two seconds while closure is
pending. A responsive page may still be awaiting a slow `getUserMedia` promise,
which cannot be cancelled; when the stream arrives, the host stops it before
publishing frames or samples. The title marker remains until physical closure is
confirmed. A renderer that fails to answer a probe is terminated, releasing its
devices; the existing page-loss UI then offers a reload. Movie replacement
preserves this watchdog for the old movie. A committed document navigation or process
loss releases retired capture state, so a reload that loads slowly is never killed for
the old page's tracks. Stale permission and activity
messages cannot authorize a replacement movie.

Before consent, Chromium may expose only an unnamed default device. The desktop
keeps this restriction: Electron's [permission check API](https://www.electronjs.org/docs/latest/api/session#sessetpermissioncheckhandlerhandler)
has no separate enumeration-only permission. Allowing `media` at that check also
answers permission checks used by capture APIs. `Camera.names` and
`Microphone.names` therefore gain labels and additional devices after consent;
this differs from Flash's pre-consent device list.

The browser implementation also exposes explicit permission requests for AIR
content running in a web embedding. It briefly opens and closes the requested
device through the browser's normal consent, without attaching it to a Video
or listening to its samples. Embedding refusal and lifetime abort still apply.

## 7. Not in scope

AVM1 `Camera.get` and `Video.attachVideo` are not supported. Embedded SWF video
streams and NetStream playback are also not implemented.

`NetStream.attachCamera` and `attachAudio` publish to a media server over
RTMP; without RTMP they go nowhere, as today, until a separate project
says otherwise. `CameraUI` and `CameraRoll` are AIR mobile's.

## Tests and reference limits

`tests/web/capture-devices.ts` compiles AS3 movies and runs them in the web
component with Chrome's fake camera: no prompt before use, consent and revocation,
copies, retained pictures, motion, stopped timelines, cached filters and child
unload. `tests/web/capture-audio.ts` uses a generated continuous PCM tone to check
all six rates, a 100 ms busy frame, one-fps delivery, activity timeouts and real
loopback. The worklet unit test delays acknowledgements over 10,000 blocks and
checks bounded storage. New regressions are checked by deliberately breaking the
implementation and observing failure.

`tests/player/video.ts` compares generated live pictures with bitmap rendering,
including filters, hidden-cache changes, CPU copies and context restoration.
`tests/desktop/capture.ts` uses fake devices and the test-only main inspector for
permission dialogs, mixed requests, device labels, Stop, slow opens and frozen
renderers. The no-device player case has Flash/adl references. Device behavior
and activity scales remain documented or inferred where Linux adl cannot measure
them; generated FLV probes establish the device-independent Video copy rules.
