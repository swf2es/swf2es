# Sound

## Sound state

`SoundTransform` keeps its volume and four channel coefficients on each
AVM2 object. The `pan` getter and setter remain playerglobal's AS3 code,
which derives them from those coefficients. A `SoundChannel` copies the
transform it receives, with the channel coefficients truncated to hundredths
as Flash's sound-transform corpus trace shows, and the four gains reach the
browser's left and right outputs through Web Audio. `Sound` classes bound by
SymbolClass to a DefineSound tag find its encoded samples in the library.
The player decodes MP3, uncompressed 8/16-bit or ADPCM sound on first play
(ADPCM as Ruffle's decoder does, to 16-bit samples the browser host in
`media/audio.ts` plays as uncompressed ones), sharing
a decode when separate loads contain the same sound (`scripting/symbols.ts`). The shared cache holds
decoded audio while a sound uses it; entries leave when no SWF holds their
sound definition, so unused audio can be collected. The parser leaves the
MP3 seek word out of the encoded bytes; the tag's sample count and rate,
not the decoder's duration, give the embedded sound's `length`.

`Sound.extract` gives a sound's samples at 44.1 kHz in stereo as adl
does (`media/extract.ts`, the `sound-extract` case): each sample held for
as many as its rate falls short, and positions counting the sound's own
samples. An uncompressed or ADPCM sound is decoded for it at once, whole
samples only; ADPCM as adl has it, each packet's header its first sample,
in blocks of 2048 samples the last of which runs on past the data, and
with adl's seeks, whose packets' offsets wrap in 32 bits. An MP3 is
decoded for it apart from the decode it plays, the first time a script
extracts it, and kept: at the MP3's own rate, of
whole frames, with a Xing or Info header frame as a frame of silence, as
Flash decodes it rather than trimmed by it as a browser would, and a
DefineSound's seekSamples skipped. Playback keeps the browser's decode of
the whole file at the device's rate, gapless trimming and all, which
resamples better than a buffer played at another rate. Flash's decode is
at once, so extraction uses `@swf2es/native/mp3`, separately from Web Audio.
Its upstream source is the pinned `vendor/minimp3` submodule (swf2es/minimp3,
a fork of lieff/minimp3); the Zig adapter (`src/mp3/root.zig`) and TypeScript
wrapper are in `packages/native`, built with its other binaries.
The module compiles once before ActionScript libraries run, and an extraction
instantiates a decoder only on first use. Its fixed 128 KiB workspace holds
one frame's encoded bytes and interleaved PCM, copied into the sound's cached
channel buffers. No host functions are imported. The generated 29 KB
binary is embedded in the package; ordinary builds verify its input
digest, and CI rebuilds it with the pinned Zig 0.17.0, whose clang
compiles minimp3 unchanged. An engine that cannot compile it loads SWFs
as usual, and extract writes no samples for an MP3. Otherwise a first
extract supplies samples synchronously, including inside
`SampleDataEvent` callbacks, even without an audio device. Extracted samples are weakly cached
by the sound character or loaded sound; appending compressed bytes invalidates
the latter's cache. Unused sounds are never decoded.
`media/mp3.ts` finds an MP3's frames: a run of three headers where they
say the next frames are starts it, and it runs on past ID3v2 tags and
other bytes between frames.

`loadPCMFromByteArray` reads 32-bit floats or 16-bit integers in the
ByteArray's byte order and brings them to 44.1 kHz at once; adl's reads
back samples that have nothing to do with those it was given, so the
case checks only its counts, lengths and errors.
`loadCompressedDataFromByteArray` adds MP3 bytes to those the sound has
(a SWF's sound keeps its own): its length counts their frames by their
headers at once, a frame cut short too, as Flash's, reading on from
where the bytes before stopped; the sound is decoded only when it plays
or a script extracts it.

An external `Sound.load` uses the same host fetch as `URLStream`; its
open, progress and complete or error reach ActionScript on a frame, after
the host has decoded it. `Sound.play` gets a channel immediately, with
start time, repeats, stop and sound transform. Sound-complete is delivered
on a frame. A stopped channel's `position` stays where it stopped. A page
may provide an `AudioHost` to `Scripting`; without one, the player keeps
the script-visible sound state but emits no audio.

An empty `Sound` with a `sampleData` listener streams stereo float PCM at
44.1 kHz. `media/dynamic-sound.ts` requests samples synchronously on first
play, then refills against the audio device's consumed samples. Each channel
keeps its own ByteArray, resetting its position before each callback while
preserving its contents and endian, as AIR does. The write position counts
the supplied frames: fewer than 2048 ends the stream after those samples,
and more than 8192 reports RangeError 2004. A write cursor beyond the
logical data length reports EOFError 2030 and ends the stream. Sample buffers are copied before
scripts can reuse them. The sound's `length` stays zero; its channel's position
tracks consumed samples and freezes on stop.

`AudioHost.stream`, when supplied, accepts the PCM blocks without a decode
or a conversion to 16-bit samples. The browser schedules consecutive Web Audio
buffers on one device clock and mixer, with bounded buffering and a refill
timer independent of the SWF's frame rate. Completion waits for queued audio
to drain and is dispatched on a player frame. Stop, stopAll and destruction
cancel refills and queued sources. Failed startup or refill releases the channel
and its device resources, even if stopping a failed device also throws.
A host without streaming keeps script-visible
state and sample requests on the player clock, without emitting this audio.

`SoundMixer.soundTransform` is one transform per player, stored in
hundredths as a channel's is, and its getter returns a copy. What a channel
sends to the device is its own transform and the mixer's, combined as
Ruffle's `SoundTransform::concat` computes them (only two transforms that
both cross channels depend on the order, which no trace shows), so setting the mixer's updates
every playing channel through `PlayingSound.setMix` and applies to every
later one. `SimpleButton.soundTransform` reads and writes the mixer's, as
in Flash (the `sound-mixer` case and the corpus's
`simplebutton_soundtransform`). `stopAll` stops every channel without a
sound-complete, and every timeline sound. `bufferTime` is kept, 5 seconds at first, and rejects a
negative one with RangeError #2027; `areSoundsInaccessible` is false.
`computeSpectrum` writes 512 zero floats and rewinds the ByteArray, which
is what Ruffle writes with no sample history and what Flash writes while
nothing plays: the player reads no output back from the device. AIR's
`audioPlaybackMode` and `useSpeakerphoneForVoice` are kept and checked as
AIR checks them; their API version hides them from a SWF.
DefineSound's Nellymoser and Speex formats, ByteArray sound loading and ID3
are later slices. MP3 seek samples are parsed but not yet applied to decoded
browser audio.

## Timeline sounds

A timeline plays sounds of its own, which no script sees: StartSound and
StartSound2 on its frames, its stream (SoundStreamHead or SoundStreamHead2,
and a SoundStreamBlock a frame), and a button's DefineButtonSound. The
library's `sounds` hook (`TimelineSounds`, made by `media/sounds.ts`
for every AS3 library a `Scripting` loads) plays them through
the page's `AudioHost`; a player without one plays none, and a SWF without
them pays nothing. AVM1 libraries use the same hooks through their own
SoundHost, including AVM1 movies loaded by an AS3 Loader.

A frame's StartSound tags play as the playhead enters it, played on to,
looped to, or landed on by a goto, but a goto to the frame the clip is on,
as Ruffle's `run_goto` has it; the frames a goto passes over play none.
StartSound2 names its sound by the class SymbolClass bound to it. A
SOUNDINFO's in and out points (samples at 44.1 kHz) bound each loop, its
loop count repeats it, and its envelope scales its left and right channels
from the start, linear between points, the first point's level held before
it, as Ruffle's `EnvelopeSignal` does, through gain automation on the
browser host (`PlayShape`). SyncNoMultiple starts none while the timeline
plays the sound anywhere, and SyncStop stops every instance the timeline
started, as Ruffle's `perform_sound_event` does for the timeline's. Both
leave a script's channels of the sound out: a channel plays on through a
SyncStop, as adl shows (the `timeline-sounds` case's channel completes),
where Ruffle stops it; and SyncNoMultiple does not see one, where Ruffle
does, which adl cannot show.

A clip's stream is its blocks back to back (`streamSound` in `media/audio.ts`:
MP3 blocks give their sample counts, PCM's are whole frames of their
bytes, and each ADPCM block decodes on its own, headers and all), made one
sound when it first plays and shared by every clip of the timeline; the
joined sound, and its decode while a clip plays it, live as long as the
library does. The block of a frame a playing clip enters, with no stream
of its playing, starts it there, as Ruffle's `sound_stream_block` does,
and it runs to the end of that run of frames with blocks, or, for MP3,
which plays over gaps, to its last block. It stops as the clip stops (the
`playing` setter of `MovieClip`), at a goto to another frame, before the
frame it lands on starts it again if the clip plays (a goto to the frame
it is on leaves it be, as Ruffle's `goto_frame_now` does), and on the
single frame of a clip of one. When the timeline takes the clip off it
stops too, and the clip plays its removal frame but starts no stream
there: the player's choice, as the clip plays no more; Ruffle's AS3 clip
keeps its stream, and adl cannot show Flash's. A clip a script takes off
plays on as an orphan and keeps its stream, as in Ruffle. `unloadAndStop`
stops the timeline sounds of all under the content, event sounds too, and
`stopAll` every one, a stream starting again at the next block its clip
plays on to. A stream counts the time its clip advances, using the stage
frame rate of each frame. `PlayingSound.positionMs`, when supplied by the
host, is elapsed playback from the requested start, including `atMs` and
any wait for the device to start; it is NaN before playback begins, follows
the audio device clock, and freezes when stopped or ended. Whole frames of
audio lead request the bounded catch-up described above. Hosts without a
cursor retain ordinary pacing. MP3 gaps retain their timeline duration:
cumulative sample offsets are not treated as jumps to later block frames.

A button's change of state plays DefineButtonSound's sound for it, as
Ruffle's button events pick them: up to over, over to down, down to over,
and over to up, and a release outside plays over to up's (the pointer's
up, with a button pressed and something else under it). A pressed
button dragged off shows its over state until the release, and its down
state again when the pointer comes back, as Flash Player 32 shows them
(`tests/unit/player/input/pointer.test.ts`); those two changes play
none, as Ruffle's DragOut and DragOver do. A button pressed elsewhere and
dragged onto stays up until the release over it, which shows over.

A timeline sound's mix is the transforms of its clip or button and each
ancestor, a sprite's `soundTransform`, concatenated from it up, then the
mixer's, as Ruffle's `transform_for_sound` does; setting a sprite's or the
mixer's updates every timeline sound playing. A stream starts on the
device once its decode is done, as far into it as the player's clock has
run since it was due, so that one whose first decode took frames keeps
with its timeline; on a device the page has not yet let run (a suspended
`AudioContext`, whose time stands still before the first gesture or
through a slow resume), the browser host starts it when it runs, as far
in again as it waited. An event sound plays whole, late if its decode or
the device kept it waiting: a click's start is not lost. A sound is over,
for SyncNoMultiple, once the clock has run its length, in and out points
and loops counted; the device may still play it, and a stop still reaches
it until the device is done with it
(`PlayingSound.ended`), or, for a host that cannot tell, until 100 ms
later, when it is stopped for good. A stream stays attached until its
clip passes its final block, stops, seeks, loops or is removed. The device
ending first must not restart audio from a lagging timeline block. At
most 32 sounds play at once, Flash's 32 channels and Ruffle's `AudioManager::MAX_SOUNDS`: a script's channels
whose sound is there to play, and the timeline's sounds the device has,
or will have once decoded, together. Past them a timeline sound does not
start, nor queue on a device that is not running, and `Sound.play` gives
null, as Flash's and Ruffle's do; a channel of a sound still loading
holds no channel until it can start. adl cannot
show what a timeline plays (its `computeSpectrum` reads nothing of an
event sound or a stream), so the node tests (`media/timeline-sounds.test.ts`)
check, through a device that logs, what starts and stops, when, how far
in, and with which mix; the `timeline-sounds` case checks that the frames
go on as in Flash.
