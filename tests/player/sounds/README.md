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
