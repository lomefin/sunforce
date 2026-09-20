# Audio drop-in

**Convention over configuration.** You drop a file in, and nothing else changes.

## Stage music

```
public/audio/music/<musicId>.webm      <- preferred (Opus, small, gapless)
public/audio/music/<musicId>.ogg
public/audio/music/<musicId>.m4a
public/audio/music/<musicId>.mp3       <- fine, but has encoder-padding gaps
```

The `musicId` is declared by the stage in `src/data/stages/stage-N.ts`, and it matches the
stage id. So the six tracks are simply:

```
public/audio/music/stage-1.webm
public/audio/music/stage-2.webm
public/audio/music/stage-3.webm
public/audio/music/stage-4.webm
public/audio/music/stage-5.webm
public/audio/music/stage-6.webm
```

The loader tries the extensions in the order above and takes the first that exists.

**A missing file is not an error** — the stage plays in silence and logs one console warning.
So the engine always runs, whether or not the music has arrived yet.

### Looping

Music plays through an `AudioBufferSourceNode`, not an `<audio>` element, because
`HTMLAudioElement.loop` inserts an audible gap at the seam.

If a track should loop at a musically correct point rather than at the file boundaries, set
`loopStart` / `loopEnd` (in **seconds**) on the stage definition. Leave them off and the whole
file loops.

## Sound effects

```
public/audio/sfx/<sfxId>.webm
```

`sfxId` values are an enum in `src/core/contracts.ts` — hit sparks, whiffs, blocks, footsteps.
Same fallback rule: missing means silent, never broken.

## Mixing

Buses are `master -> limiter`, with `music`, `sfx`, `hit`, `voice`, `foley` and `ambience`
feeding in. Music ducks under big hits via a manual gain envelope, so a kick punches through
the mix without the music audibly pumping.
