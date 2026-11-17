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
  `rate` of 5, 8, 11, 22 or 44 kHz (8 by default), `gain` 0–100,
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

## 4. Camera

The natives keep today's surface and gain a device behind it: `names`
from the host, `getCamera` a `Camera` bound to one device, `muted` until
the host says granted, the status events as Flash sends them,
`width`/`height`/`fps`/`currentFPS` from the track's settings, and the
motion detector: the mean difference of consecutive frames, sampled small,
against `motionLevel`, raising `ActivityEvent` after `motionTimeout`. The
11.4 copies go through the CPU frame of section 3.

## 5. Microphone

An AudioWorklet on a `MediaStreamSource` hands blocks of samples to the
player, which resamples them from the device's rate down to `rate` (new:
`Sound.extract` only holds a sound's samples up to 44.1 kHz,
`packages/player/src/media/extract.ts`) and dispatches `sampleData` on
the frame, as Flash did between frames. `activityLevel` is the block's RMS on
Flash's 0–100 scale against `silenceLevel` and its timeout; `gain` is a
gain node before the worklet; `setLoopBack` routes the input to the
player's own output, behind the same unmute rule as its sounds.

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

- Where a camera is attached to a `Video` before the user answers, does
  Flash show the box empty or its first frame once allowed, and do two
  `getCamera()` calls return the same `Camera`? To confirm in Flash on a
  machine with a camera.
- `activityLevel` before any capture: Adobe documents -1 for an inactive
  microphone; the camera's, and when each goes from -1, to confirm.
- Whether the web element should prompt on attach, as Flash did, or only
  after the user's first gesture on the player, as browsers prefer.
