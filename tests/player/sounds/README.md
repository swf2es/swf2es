Sounds made for the player's tests: a quarter second of a 440 Hz sine on
the left and a 660 Hz one on the right, at 44.1 kHz stereo and 96 kbit/s
without LAME's header frame (`tone.mp3`) and with it (`tone-tagged.mp3`),
and the two mixed to mono at 22.05 kHz and 32 kbit/s (`tone22.mp3`). They
are this repository's own. FFmpeg n9.0.2 and LAME 4.0 made them, byte for
byte, with:

```sh
ffmpeg -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=0.25" \
  -f lavfi -i "sine=frequency=660:sample_rate=44100:duration=0.25" \
  -filter_complex "[0:a]volume=0.5[l];[1:a]volume=0.25[r];[l][r]join=inputs=2:channel_layout=stereo[a]" \
  -map "[a]" -c:a pcm_s16le tone.wav
lame --quiet -t -b 96 --resample 44.1 -m s tone.wav tone.mp3
lame --quiet -b 96 --resample 44.1 -m s tone.wav tone-tagged.mp3
ffmpeg -loglevel error -y -i tone.wav -ar 22050 -ac 1 tone22.wav
lame --quiet -t -b 32 --resample 22.05 -m m tone22.wav tone22.mp3
```

`tone22.nelly` is the two tones mixed at 22.05 kHz, as above but with
their own levels, in Nellymoser (DefineSound's format 6): the 64-byte
blocks of FFmpeg's encoder, out of an FLV's audio tags without their
flag bytes. `tone22-nelly.pcm` is what FFmpeg's decoder makes of them,
16-bit little-endian. FFmpeg 7.1.2 made them with:

```sh
ffmpeg -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=22050:duration=0.25" \
  -f lavfi -i "sine=frequency=660:sample_rate=22050:duration=0.25" \
  -filter_complex "[0:a]volume=0.5[a];[1:a]volume=0.25[b];[a][b]amix=inputs=2:normalize=0[m]" \
  -map "[m]" -c:a pcm_s16le tone22n.wav
ffmpeg -loglevel error -y -i tone22n.wav -c:a nellymoser -f flv tone22.flv
# each FLV audio tag's payload after its first byte, back to back: tone22.nelly
ffmpeg -loglevel error -y -i tone22.flv -f s16le -acodec pcm_s16le tone22-nelly.pcm
```
