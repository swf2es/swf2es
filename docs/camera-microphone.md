# Camera and microphone

Status: draft plan, for review. Read against `dev` at 100d774c.

## Why

`flash.media.Camera` and `Microphone` behave today as Flash Player does on
a machine with neither (`packages/player/src/playerglobal/flash/media/`):
supported, no names, `getCamera()` and `getMicrophone()` null. `Video`
draws an empty box (`packages/player/src/display/videoobject.ts`). Real
content uses them: webcam toys and photo booths, voice recorders, games
played by blowing into the microphone, video chat front ends. None of the
corpus does, so this is for content, not for the score.

Every piece is a browser API Chromium has: `getUserMedia`,
`enumerateDevices`, AudioWorklet, and WebGL texture uploads from a video
element or a `VideoFrame`. No native package and no codec is needed: the
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
samples delivered, its state (granted, denied, ended) told, and stopped.
The player never calls a browser API itself, so node and the tests can
leave it out (today's behaviour) or fake it.

The browser implementation goes in `@swf2es/player-hosts`:
`getUserMedia({ video })` or `({ audio })` with the constraints
`setMode` and `getEnhancedMicrophone` ask for (`width`, `height`,
`frameRate`, `echoCancellation`, `noiseSuppression`), and
`enumerateDevices` for the names, whose labels Chromium gives only once
permission is granted. The desktop page uses the same implementation; it
differs only in who answers the permission (section 6).

## 3. Live video in the renderer

The largest part, and the one NetStream's playback needs too, so it is
built once for both. A `Video` gets a source; while one is attached, each
frame the renderer uploads its current picture as a texture
(`texImage2D` of a video element, or of a `VideoFrame` from
`MediaStreamTrackProcessor` where that is cheaper) and draws the box as a
textured quad with the `Video`'s transform, colour transform, filters and
`smoothing`. A frame not yet changed is not uploaded again.

`BitmapData.draw(video)` and the camera's copies read the frame on the
CPU (`VideoFrame.copyTo`, or `drawImage` into an `OffscreenCanvas` and
`getImageData`), never by a GPU readback, which stalls (docs/cpu-raster.md).

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

`Video.clear()` hides the current picture until the source publishes
another frame, without stopping the source. This follows
[Adobe's Video documentation](https://airsdk.dev/reference/actionscript/3.0/flash/media/Video.html#clear()),
not a device observation under adl. The generated-canvas test covers
frame orientation, sharing, resizing, smoothing, colour transforms,
cached filters, CPU copies and context restoration. Existing Flash cases
continue to cover Video without a source.

## 4. Camera

The natives keep today's surface and gain a device behind it: `names`
from the host, `getCamera` a `Camera` bound to one device, `muted` until
the host says granted, the status events as Flash sends them,
`width`/`height`/`fps`/`currentFPS` from the track's settings, and the
motion detector: the mean difference of consecutive frames, sampled small,
against `motionLevel`, raising `ActivityEvent` after `motionTimeout`. The
11.4 copies go through the CPU frame of section 3.

The browser host enumerates before AS3 starts so synchronous `names` and
`getCamera` can use the result without prompting. It opens capture only
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
on 32×24 samples, an approximation to Flash's unpublished detector.

`allowcapture="false"` and `configure({ allowCapture: false })` refuse
capture. Revoking the attribute aborts captures for that load; enabling
it again requires reloading. The capture host's signal also closes tracks
when permission resolves after the player has already been destroyed.

## 5. Microphone

An AudioWorklet on a `MediaStreamSource` hands blocks of samples to the
player, which resamples them from the device's rate down to `rate` (new:
`Sound.extract` only holds a sound's samples up to 44.1 kHz,
`packages/player/src/media/extract.ts`) and dispatches `sampleData` on
the frame, as Flash did between frames. `activityLevel` is the block's RMS on
Flash's 0–100 scale against `silenceLevel` and its timeout; `gain` is a
gain node before the worklet; `setLoopBack` routes the input to the
player's own output, behind the same unmute rule as its sounds.

The implementation starts capture when a `sampleData` listener or loopback
needs it, and closes capture when neither remains. Device defaults, status
codes and enhanced-device exclusivity follow [Adobe's Microphone reference](https://airsdk.dev/reference/actionscript/3.0/flash/media/Microphone.html),
not device observations under adl. Without a host the existing defaults
and null getters are unchanged.

The worklet mixes to mono and sends 2048-sample blocks after gain (50 is
unity). An acknowledgement limits it to one outstanding message. The player
uses a 96-tap windowed-sinc low-pass converter with continuous phase and
history, including 48 kHz devices and the 16 kHz rate. The 5/11/22/44 modes
use the 44.1 kHz family (5512.5/11025/22050/44100 Hz); 8/16 use 8000/16000 Hz.
Activity uses clipped PCM RMS, an approximation to Flash's unpublished
meter. Audio and activity events are bounded while SWF frames are paused.
A rate change discards pending old-rate data rather than mixing rates in
one event. Sample positions count produced samples, including discarded
ones. Loopback is bounded to about 200 ms of pending audio and goes through
the existing output host, SoundTransform and unmute rule.

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
  `camera` and `microphone`. The `<swf2es-player>` element gets an
  attribute, and `configure` an option, to refuse captures outright, as
  `allowScriptAccess` restrains scripting.
- In the desktop app, the session's permission handlers refuse everything
  but full screen today (`apps/desktop/src/main/main.ts`). They would let
  `media` through only after a dialog of the app's own that names the
  SWF's origin and the device. On macOS the app asks the system first
  (`systemPreferences.askForMediaAccess`). While a device is live the
  window's title says so and a menu item stops it; a page that ends
  (#1037's `onPageEnd`) stops its tracks. Remembered answers per site,
  as Flash's Settings Manager kept them, and a device menu can follow.
- For an AIR application, `permissionStatus` and `requestPermission()`
  are answered by the same dialog, and `PermissionEvent` follows.

## 7. Not in scope

`NetStream.attachCamera` and `attachAudio` publish to a media server over
RTMP; without RTMP they go nowhere, as today, until a separate project
says otherwise. `CameraUI` and `CameraRoll` are AIR mobile's.

## 8. Tests

Chrome's `--use-fake-device-for-media-stream` gives a moving test pattern
and a tone, and `--use-fake-ui-for-media-stream` answers the prompt, in
Chrome and in Electron alike, so CI can check: names, the muted and
unmuted events for a yes and a no, frames reaching a `Video` and
`BitmapData.draw`, `setMode` changing the size, `activityLevel` moving
with the pattern, `sampleData` at each `rate`, and the desktop dialog
answered through the test inspector as #1037's test answers its box.

## 9. Order and effort

1. Live video in the renderer, with a test source (section 3): 3–4 days.
2. The capture host and Camera (sections 2 and 4): 2–3 days.
3. Microphone (section 5): 3–5 days.
4. The desktop's dialog and macOS consent: half a day; remembered answers,
   indicator and menu: a day.

## Open questions

- Camera identity and the empty Video while waiting for consent follow
  Adobe's documentation (section 4); hardware-backed Flash confirmation
  remains unavailable here.
- Camera and Microphone activity before monitoring are -1, following Adobe;
  the detectors are documented approximations (sections 4 and 5).
- The web element requests capture on attach, as described in section 4;
  the browser remains responsible for consent.
