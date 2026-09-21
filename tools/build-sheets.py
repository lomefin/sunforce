#!/usr/bin/env python3
"""
SunForce — sprite sheet builder.

Two jobs, one command (`npm run sheets`):

  1. SPRITES.     Scans assets/movements/*.png, groups them by costume prefix,
                  and emits one packed atlas + one SpriteSheet JSON per costume
                  into public/art/.
  2. BACKGROUNDS. Stages assets/backgrounds/*.png into public/art/stages/ so
                  the painted panoramas are served at /art/stages/<name>.png.

DROP A PNG IN AND RE-RUN. Naming is the whole interface:
    <costume>-<clip>.png        e.g. male-caporal-neutral.png
    <costume>-<clip>-<n>.png    e.g. female-caporal-walk-2.png
Those two shapes and nothing else: a name that is neither (…-hard-hit02.png) is
a typo, and is reported and skipped rather than shipped as a one-frame clip that
no animation will ever ask for.

THE TWO ALIGNMENT RULES (the only hard part of a sprite pipeline):
  * GROUNDED frames anchor on the SOLE — the lowest opaque pixel sits on the
    world ground line, so the character never floats or sinks.
  * AIRBORNE frames cannot anchor on a sole (the feet are tucked up), so they
    anchor on the HEAD, offset down by the costume's own standing height. The
    origin then lands where the feet WOULD touch, which is what the sim's posY
    expects. This puts origin.y below the bitmap on tucked frames — that is
    correct, and contracts.ts says so explicitly.

BACKGROUNDS are NOT repacked, resized or cropped. A stage panorama is placed in
the world by numbers that live in src/data/stages/<stage>.ts — a ground line as
a fraction of image height, a world height, a parallax — and every one of those
numbers is derived from the SOURCE pixel dimensions. Resampling here would
silently invalidate all of them. So the only processing is flattening onto black
(a backdrop must be opaque; a stray alpha channel shows as a hole in the sky)
and stripping metadata. The reported size and aspect are what the stage file has
to agree with, which is why they are printed every run.

Idempotent: a destination newer than its source is left alone.

Requires ImageMagick (`magick`) on PATH.
"""
import json, os, re, shutil, subprocess, sys
from collections import defaultdict
from math import gcd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC  = os.path.join(ROOT, 'assets/movements')
OUT  = os.path.join(ROOT, 'public/art')
BG_SRC = os.path.join(ROOT, 'assets/backgrounds')
BG_OUT = os.path.join(ROOT, 'public/art/stages')
SCALE, PAD, ALPHA_FLOOR = 0.45, 4, '12%'
FIGHTER_UNITS = 378.0          # must match CharDef/FEEL-NUMBERS

# Hitstun spans the reaction clips are paced against (sim frames, from the move
# table): a jab is 16, a kick 21. Presentation picks HIT_STAND vs HIT_STAND_HARD
# by recovering the original hitstun (hitstun + stateFrame) and thresholding at
# 19, so these two numbers are exactly the spans the two clips have to cover.
SOFT_HITSTUN, HARD_HITSTUN = 16, 21
# BLOCKSTUN_PUNCH / BLOCKSTUN_KICK from src/core/contracts.ts. The clip covers
# the LONGER of the two and holds (loopAt -1), so a blocked punch simply ends
# early rather than the drawing running out under a blocked kick.
BLOCKSTUN = 14
# The KO pose is HELD (loopAt -1), so this is only how long its drawings take to
# play through if a costume ever has more than one. KO_SLOWMO_FRAMES from
# contracts.ts is the span it has to cover, and the sim runs it at 30% speed.
KO_CLIP_FRAMES = 45
# A dash is ~20 frames (CompiledChar.dashFrames). It has no art of its own, so
# it borrows the WALK cycle run fast — a dash reads as a hard lean either way,
# and rendering it as IDLE (which is what a missing clip falls back to) made the
# move look like it had not happened at all.
DASH_CLIP_FRAMES = 20
# THE CELEBRATION, and its two shapes. A Caporal strikes one pose and settles
# into a second; a Tinku keeps swapping between them. So the clip is the same
# drawings either way and only `loopAt` and the pacing differ, keyed on the
# troupe the costume belongs to. A troupe not listed here holds, which is the
# safer default: a held pose can look stiff, a looped one can look broken.
WIN_CLIP_FRAMES = 96
WIN_STYLE = {
    'caporal':  'hold',   # frame 1, a beat, then frame 2 and stay there
    'tinku':    'loop',   # back and forth between the two
    'diablada': 'hold',
}
# THE IDLE BREATH, in sim frames for one full cycle. A fighting game's rest pose
# is never still. A full second read as sluggish on four drawings, so this is
# two thirds of one: brisk enough to look alive, slow enough not to jitter.
# Shared out over however many drawings the costume has, so adding a fifth pose
# makes each one shorter, not the loop longer — the character keeps breathing at
# the same rate. Four drawings at 10 frames each today.
IDLE_CYCLE = 40

# A frame file is <costume>-<clip>.png or <costume>-<clip>-<n>.png, and the clip
# part is words only. 'hard-hit-2' is frame 2 of hard-hit; 'hard-hit02' is a typo
# and gets reported instead of silently becoming its own one-frame junk clip.
CLIP_RE = re.compile(r'^[a-z]+(?:-[a-z]+)*(?:-\d+)?$')

# which costume each roster slot wears. C-F are copies until they get their own.
# Six distinct costumes, six slots — no repeats.
ROSTER = {'a':'male-caporal',  'b':'female-caporal', 'c':'male-tinku',
          'd':'female-tinku',  'e':'male-diablada',  'f':'female-diablada'}

# IMAGEMAGICK 7 OR 6. Version 7 ships one `magick` binary that fronts
# everything; version 6 ships `convert` and `identify` as separate programs and
# has no `magick` at all. Ubuntu's `imagemagick` package is STILL 6, which is
# what the Pages workflow installs and what most Linux contributors will have,
# so both are supported rather than making 7 a hard requirement.
_IM7 = shutil.which('magick') is not None
_IM6 = shutil.which('convert') is not None and shutil.which('identify') is not None

def im_argv(args):
    """The argv for one ImageMagick call, in whichever dialect is installed.
    `args` is written the way 7 wants it — an `identify` subcommand, or a plain
    convert-style pipeline — and is translated for 6 when that is what we have."""
    if _IM7:
        return ['magick'] + args
    if args and args[0] == 'identify':
        return ['identify'] + args[1:]
    return ['convert'] + args

def require_imagemagick():
    if _IM7 or _IM6:
        return
    sys.exit(
        'build-sheets: ImageMagick not found.\n'
        '  macOS         brew install imagemagick\n'
        '  Debian/Ubuntu sudo apt install imagemagick\n'
        'Needs either the v7 `magick` binary or the v6 `convert` + `identify` pair.')

def mg(args):
    return subprocess.run(im_argv(args), capture_output=True, text=True).stdout.strip()

def has_alpha(path):
    """Does this frame carry a real alpha channel?

    A sprite without one is not a sprite. The crop below is driven ENTIRELY by
    alpha, so an opaque export has a bounding box of the whole canvas: the
    background gets packed into the atlas as part of the frame, the character is
    anchored on the canvas edge instead of on its own soles, and it renders as a
    rectangle of background colour standing in the wrong place. That is exactly what
    `female-caporal-win-2.png` did — a black box, out of bounds.

    Cheaper to refuse it here than to explain it later."""
    return mg([path, '-format', '%A', 'info:']).strip().lower() not in ('undefined', 'false')

def bbox(path, crop=None):
    a = [path] + (['-crop', crop, '+repage'] if crop else [])
    a += ['-alpha','extract','-threshold',ALPHA_FLOOR,'-format','%@','info:']
    m = re.match(r'(\d+)x(\d+)\+(\d+)\+(\d+)', mg(a))
    return tuple(map(int, m.groups())) if m else None

PORTRAIT_KINDS = ('selector', 'selected')
PORTRAIT_SRC = os.path.join(ROOT, 'assets/portraits')
PORTRAIT_OUT = os.path.join(ROOT, 'public/art/portraits')
PORTRAIT_W = 760          # UI never draws these wider than ~486 at 2x DPI

def stage_portraits():
    """Copy the select-screen portraits out of assets/ and downscale them.

    These are UI art, NOT fight frames: they are deliberately kept OUT of the
    sprite atlas, which the fight loads every match and which would otherwise
    carry megabytes it never draws."""
    os.makedirs(PORTRAIT_OUT, exist_ok=True)
    made = []
    # assets/portraits/ is the home. assets/movements/ is still read as a
    # fallback so a file dropped in the old place still ships rather than
    # silently going nowhere — it just gets reported.
    roots = [PORTRAIT_SRC] + ([SRC] if os.path.isdir(SRC) else [])
    seen = set()
    for root in roots:
        if not os.path.isdir(root):
            continue
        for fn in sorted(os.listdir(root)):
            if not fn.endswith('.png'):
                continue
            stem = fn[:-4]
            m = re.match(r'^([a-z]+-[a-z]+)-(' + '|'.join(PORTRAIT_KINDS) + r')$', stem)
            if not m or stem in seen:
                continue
            seen.add(stem)
            if root is not PORTRAIT_SRC:
                print(f'  ! {fn} is in assets/movements/ — it belongs in '
                      f'assets/portraits/ (shipped anyway)')
            dst = os.path.join(PORTRAIT_OUT, f'{m.group(1)}-{m.group(2)}.png')
            tmp = dst[:-4] + '.tmp.png'
            subprocess.run(im_argv([os.path.join(root, fn),
                            '-resize', f'{PORTRAIT_W}x>', tmp]), check=True)
            os.replace(tmp, dst)
            made.append((m.group(1), m.group(2), mg(['identify', '-format', '%wx%h', dst])))
    if made:
        print('select-screen portraits:')
        for c, k, size in made:
            print(f'  {c}-{k}: {size} -> /art/portraits/{c}-{k}.png')
    return {c for c, _k, _s in made}

def scan():
    groups = defaultdict(dict)
    skipped = 0
    for fn in sorted(os.listdir(SRC)):
        if not fn.endswith('.png'): continue
        stem = fn[:-4]
        # costume = the first TWO name segments (e.g. male-caporal,
        # female-tinku); everything after is the clip. Hardcoding a dance
        # here is what stopped tinku art from ever being seen.
        m = re.match(r'^([a-z]+-[a-z]+)-(.+)$', stem)
        if m and m.group(2) in PORTRAIT_KINDS:
            continue          # UI portrait, staged separately by stage_portraits()
        if not m:
            print(f'  ! skip (unrecognised name): {fn}'); skipped += 1; continue
        if not CLIP_RE.match(m.group(2)):
            print(f'  ! skip (malformed clip name "{m.group(2)}", '
                  f'expected <clip> or <clip>-<n>): {fn}'); skipped += 1; continue
        full = os.path.join(SRC, fn)
        if not has_alpha(full):
            print(f'  ! skip (no alpha channel — would pack as an opaque '
                  f'rectangle): {fn}'); skipped += 1; continue
        groups[m.group(1)][m.group(2)] = full
    if skipped:
        print(f'  ! {skipped} file(s) skipped — fix the name or the alpha, or '
              f'they will never ship')
    return groups

def measure(path, is_air):
    w,h,x,y = bbox(path)
    hb = max(60, int(h*0.08))
    hw,_,hx,_ = bbox(path, f'{w}x{hb}+{x}+{y}')
    return dict(w=w,h=h,x=x,y=y, sole=y+h, head_top=y,
                head_cx=x+hx+hw/2, air=is_air, path=path)

def build(costume, clips):
    # The ANCHOR pose. `base_h` normalises the whole costume to 378 world units,
    # so it has to be one specific drawing and the same one every build. The bare
    # <costume>-neutral.png is it. A costume that only ever had numbered neutrals
    # anchors on the first of them rather than being dropped entirely.
    anchor = 'neutral' if 'neutral' in clips else next(
        (n for n in sorted(clips, key=lambda k: (len(k), k))
         if re.fullmatch(r'neutral-\d+', n)), None)
    if anchor is None:
        print(f'  {costume}: no neutral frame, skipping'); return None
    if anchor != 'neutral':
        print(f'  {costume}: no bare neutral — anchoring height on {anchor}')
    meas = {k: measure(p, k.startswith('jump')) for k,p in clips.items()}
    base_h = meas[anchor]['h']                       # standing height, px
    tmp = '/tmp/sf-sheets'; os.makedirs(tmp, exist_ok=True)

    frames = []
    for name in sorted(meas):
        i = meas[name]
        out = f'{tmp}/{costume}-{name}.png'
        subprocess.run(im_argv([i['path'],
            '-crop', f"{i['w']}x{i['h']}+{i['x']}+{i['y']}", '+repage',
            '-channel','A','-level',f'{ALPHA_FLOOR},100%','+channel',
            '-resize', f'{SCALE*100}%', out]), check=True, capture_output=True)
        w,h = map(int, mg(['identify','-format','%wx%h',out]).split('x'))
        oy_abs = (i['head_top'] + base_h) if i['air'] else i['sole']
        frames.append(dict(name=name, file=out, w=w, h=h,
                           ox=round((i['head_cx']-i['x'])*SCALE),
                           oy=round((oy_abs     -i['y'])*SCALE)))

    per_row = 4
    x=y=PAD; aw=0; row_h=0
    for n,f in enumerate(frames):
        if n and n % per_row == 0:
            x = PAD; y += row_h + PAD; row_h = 0
        f['ax'], f['ay'] = x, y
        x += f['w'] + PAD; aw = max(aw, x); row_h = max(row_h, f['h'])
    ah = y + row_h + PAD

    args = ['-size', f'{aw}x{ah}', 'xc:none']
    for f in frames:
        args += [f['file'], '-geometry', f"+{f['ax']}+{f['ay']}", '-composite']
    png = f'{costume}.png'
    # ATOMIC WRITE. The dev server serves straight out of public/art/, so a
    # rebuild during a live session must never expose a half-written file — a
    # truncated PNG decodes as a black rectangle, which is exactly what it
    # looks like: a rendering bug. Write beside the target, then rename.
    dst = os.path.join(OUT, png)
    # keep a .png extension on the temp file: ImageMagick picks the encoder
    # from the extension, and ".png.tmp" makes it fail outright.
    tmp_png = dst[:-4] + '.tmp.png'
    subprocess.run(im_argv(args+[tmp_png]), check=True)
    os.replace(tmp_png, dst)

    by = {f['name']: f for f in frames}
    def fr(name, dur):
        f = by[name]
        return {"uv":[f['ax'],f['ay'],f['w'],f['h']],
                "origin":[f['ox'],f['oy']], "dur":dur}
    has = lambda n: n in by
    def series(pre):
        """Every drawing of clip `pre`, in numeric order: 'walk' -> walk-1 ..
        walk-5, 'soft-hit' -> soft-hit-1, soft-hit-2. The stem has to match
        exactly, so a bare 'hit' never swallows 'soft-hit' and a hypothetical
        'jump-squat' never lands in the middle of the jump arc."""
        num = lambda n: re.fullmatch(re.escape(pre) + r'-(\d+)', n)
        return sorted((n for n in by if n == pre or num(n)),
                      key=lambda n: int(num(n).group(1)) if num(n) else 0)

    def spread(total, n):
        """`total` sim frames shared out over `n` drawings, remainder on the
        last — the pose we then hold is the one that gets the extra frames."""
        d = max(1, total // n)
        return [d] * (n - 1) + [max(1, total - d * (n - 1))]

    # THE IDLE BREATH. The NUMBERED neutrals are the cycle: <costume>-neutral-1
    # .. -N in order, looping. The bare <costume>-neutral.png is deliberately NOT
    # in it — it is the anchor pose (it sets the costume's scale) and it is also
    # the rest frame either side of a punch and a kick, so folding it into the
    # loop would put the same drawing on screen in two different jobs. A costume
    # with no numbered neutrals keeps its single standing pose, as before.
    idle  = [n for n in series('neutral') if n != 'neutral'] or [anchor]
    idled = spread(IDLE_CYCLE, len(idle))

    walk  = series('walk') or ['neutral']
    jumps = series('jump')
    # first ~60% of the jump art is the rise, the rest is the fall
    split = max(1, round(len(jumps)*0.6)) if jumps else 0
    rise  = jumps[:split] or ['neutral']
    fall  = jumps[split:] or (jumps[-1:] or ['neutral'])

    # ~30-frame stride cycle however many drawings there are
    wdur = max(2, round(30 / max(1, len(walk))))
    # The same drawings run through in the length of one dash.
    ddur = max(1, round(DASH_CLIP_FRAMES / max(1, len(walk))))

    # THE HIT REACTIONS. soft = the wince (jab, 16f of hitstun), hard = the head
    # thrown back (kick, 21f). Both are grounded poses, so they measured on the
    # sole like walk/punch/kick and need no special anchoring. Each set is paced
    # to cover its own hitstun span exactly and then HOLDS (loopAt -1): with the
    # two drawings we have that is 8+8 = 16 soft and 10+11 = 21 hard, so the
    # last pose is still on screen on the frame the fighter becomes actionable
    # and the recovery reads as a recovery, not as a second animation.
    # Crouch and air reactions have no art of their own yet; they borrow the
    # soft frames, because a real reaction beats standing there in neutral.
    # Nothing drawn at all -> neutral, same as before.
    # `<costume>-hit` is accepted as an alias for `soft-hit`: it is the obvious
    # name for "the hit reaction" when a costume only has one, and dropping it
    # would be the silent miss this build exists to prevent.
    soft = series('soft-hit') or series('hit')
    hard = series('hard-hit')
    soft = soft or hard or ['neutral']
    hard = hard or soft
    softd, hardd = spread(SOFT_HITSTUN, len(soft)), spread(HARD_HITSTUN, len(hard))
    # Blocking is FULLY IMPLEMENTED in the sim (canBlock / blockHeld /
    # BLOCKSTUN_*); it just had no art until now, so it rendered as IDLE.
    block = series('block') or soft or ['neutral']
    blockd = spread(BLOCKSTUN, len(block))

    # THE KO POSE. Held, never looped: the fighter is launched backwards and
    # lands in it, and it is the last thing on screen before the round ends.
    # A costume with no `-ko` drawing falls back to its heaviest reaction,
    # which reads as "floored" far better than standing there in neutral.
    ko = series('ko') or hard or soft or ['neutral']
    kod = spread(KO_CLIP_FRAMES, len(ko))

    # ...and what it lands in. The KO is TWO poses: `-ko` in the air, `-fallen`
    # on the floor. A costume with no `-fallen` keeps wearing its KO pose after
    # it lands, which is wrong but not broken.
    fallen = series('fallen') or ko
    falld = spread(KO_CLIP_FRAMES, len(fallen))

    # THE WINNER'S POSE. No art -> it keeps standing in neutral, which is a
    # non-celebration rather than a broken one.
    win = series('win') or ['neutral']
    style = WIN_STYLE.get(costume.split('-')[-1], 'hold')
    if style == 'loop':
        # Evenly split, looping: the two poses alternate for as long as it shows.
        wind = spread(WIN_CLIP_FRAMES, len(win))
        win_loop = 0
    else:
        # Hold: the FIRST pose gets a beat, the last one gets the rest and stays.
        beat = max(6, WIN_CLIP_FRAMES // (len(win) * 3))
        wind = [beat] * (len(win) - 1) + [max(1, WIN_CLIP_FRAMES - beat * (len(win) - 1))]
        win_loop = -1
    hit_soft = [fr(n, d) for n, d in zip(soft, softd)]
    clipset = {
      "IDLE":       {"loopAt":0,  "frames":[fr(n,d) for n,d in zip(idle, idled)]},
      "KO":         {"loopAt":-1, "frames":[fr(n,d) for n,d in zip(ko, kod)]},
      "KNOCKDOWN":  {"loopAt":-1, "frames":[fr(n,d) for n,d in zip(fallen, falld)]},
      "WIN":        {"loopAt":win_loop, "frames":[fr(n,d) for n,d in zip(win, wind)]},
      "WALK_F":     {"loopAt":0,  "frames":[fr(n,wdur) for n in walk]},
      "WALK_B":     {"loopAt":0,  "frames":[fr(n,wdur+1) for n in reversed(walk)]},
      "DASH_F":     {"loopAt":0,  "frames":[fr(n,ddur) for n in walk]},
      "DASH_B":     {"loopAt":0,  "frames":[fr(n,ddur) for n in reversed(walk)]},
      "JUMP_SQUAT": {"loopAt":-1, "frames":[fr('neutral',1)]},
      "JUMP_RISE":  {"loopAt":-1, "frames":[fr(n,8) for n in rise]},
      "JUMP_FALL":  {"loopAt":-1, "frames":[fr(n,10) for n in fall]},
      "LAND":       {"loopAt":-1, "frames":[fr('neutral',1)]},
      "HIT_STAND":      {"loopAt":-1, "frames":hit_soft},
      "HIT_STAND_HARD": {"loopAt":-1, "frames":[fr(n,d) for n,d in zip(hard,hardd)]},
      "BLOCK_STAND":  {"loopAt":-1, "frames":[fr(n,d) for n,d in zip(block, blockd)]},
      "BLOCK_CROUCH": {"loopAt":-1, "frames":[fr(n,d) for n,d in zip(block, blockd)]},
      "BLOCK_AIR":    {"loopAt":-1, "frames":[fr(n,d) for n,d in zip(block, blockd)]},
      "HIT_CROUCH":     {"loopAt":-1, "frames":hit_soft},
      "HIT_AIR":        {"loopAt":-1, "frames":hit_soft},
      "ATK_5P":     {"loopAt":-1, "frames":[fr('neutral',5),
                                            fr('punch' if has('punch') else 'neutral',8),
                                            fr('neutral',4)]},
      "ATK_5K":     {"loopAt":-1, "frames":[fr('neutral',9),
                                            fr('kick' if has('kick') else 'neutral',12),
                                            fr('neutral',8)]},
    }
    sheet = {"image":png, "atlasW":aw, "atlasH":ah,
             "unitsPerPx": FIGHTER_UNITS/(base_h*SCALE), "clips":clipset}
    print(f'  {costume}: {len(frames)} frames -> {png} {aw}x{ah}, '
          f'{FIGHTER_UNITS/(base_h*SCALE):.4f} units/px, walk={len(walk)} '
          f'rise={len(rise)} fall={len(fall)} '
          f'soft-hit={len(soft)}{softd} hard-hit={len(hard)}{hardd}')
    return sheet

# =============================================================================
# STAGE BACKGROUNDS
# =============================================================================

def aspect(w, h):
    """Exact w:h in lowest terms — 2172x724 -> '3:1'."""
    g = gcd(w, h) or 1
    return f'{w // g}:{h // g}'

def stage_backgrounds():
    """
    Stage every assets/backgrounds/*.png at public/art/stages/<same name>.png.

    Deliberately lossless in geometry: flatten onto black so the backdrop is
    guaranteed opaque, strip metadata, copy. Size is never touched — the stage
    data file derives its world placement from these exact pixel dimensions.

    Idempotent by mtime: a destination at least as new as its source is left
    alone, so re-running is free and never rewrites a byte.
    """
    if not os.path.isdir(BG_SRC):
        print('  no assets/backgrounds directory — nothing to stage')
        return
    pngs = sorted(fn for fn in os.listdir(BG_SRC) if fn.lower().endswith('.png'))
    if not pngs:
        print('  assets/backgrounds is empty')
        return
    os.makedirs(BG_OUT, exist_ok=True)
    for fn in pngs:
        src, dst = os.path.join(BG_SRC, fn), os.path.join(BG_OUT, fn)
        dim = mg(['identify', '-format', '%wx%h', src]).split('\n')[0]
        m = re.match(r'^(\d+)x(\d+)$', dim)
        if not m:
            print(f'  ! {fn}: not a readable image, skipped')
            continue
        w, h = int(m.group(1)), int(m.group(2))
        fresh = (os.path.exists(dst)
                 and os.path.getmtime(dst) >= os.path.getmtime(src))
        if not fresh:
            r = subprocess.run(im_argv([src, '-background', 'black',
                                '-alpha', 'remove', '-alpha', 'off', '-strip', dst]),
                               capture_output=True, text=True)
            if r.returncode != 0:
                first = (r.stderr.strip().splitlines() or ['magick failed'])[0]
                print(f'  ! {fn}: not staged — {first}')
                continue
        print(f'  {fn}: {w}x{h}, aspect {w / h:.4f} ({aspect(w, h)}) -> '
              f'/art/stages/{fn} [{"up to date" if fresh else "written"}]')

def main():
    # Fail here, with instructions, rather than inside a subprocess call with a
    # FileNotFoundError traceback thirty lines deep.
    require_imagemagick()
    os.makedirs(OUT, exist_ok=True)

    print('stage backgrounds:')
    stage_backgrounds()
    stage_portraits()

    print('sprite sheets:')
    groups = scan()
    if not groups: print('no sprites found in assets/movements'); return 1
    sheets = {}
    for costume, clips in sorted(groups.items()):
        s = build(costume, clips)
        if s: sheets[costume] = s
    # Portraits without fight frames: the select screen would look finished and
    # the match would fall back to stick figures. Worth saying out loud.
    have_art = {c for c in os.listdir(PORTRAIT_OUT)} if os.path.isdir(PORTRAIT_OUT) else set()
    portrait_costumes = {f.rsplit('-', 1)[0] for f in have_art if f.endswith('.png')}
    for c in sorted(portrait_costumes - set(sheets)):
        print(f'  ! costume "{c}" has select-screen portraits but NO fight frames '
              f'— not rostered; it would fight as a stick figure')

    unassigned = sorted(set(sheets) - set(ROSTER.values()))
    for c in unassigned:
        print(f'  ! costume "{c}" was built but no roster slot wears it '
              f'— add it to ROSTER in tools/build-sheets.py')
    for slot, costume in ROSTER.items():
        if costume not in sheets:
            print(f'  ! slot {slot}: no sheet for {costume}'); continue
        dst = os.path.join(OUT, f'{slot}.sheet.json')
        tmp = dst + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump(sheets[costume], fh, indent=1)
        os.replace(tmp, dst)          # atomic, same reason as the atlas above
    # The slot -> costume map, so the UI can find a character's portraits without
    # parsing a sprite sheet just to read a filename. ROSTER lives in this file;
    # this is how the TypeScript side learns it.
    rjson = os.path.join(OUT, 'roster.json')
    rtmp = rjson + '.tmp'
    with open(rtmp, 'w') as fh:
        json.dump({k: v for k, v in sorted(ROSTER.items())}, fh, indent=1)
    os.replace(rtmp, rjson)
    print(f'wrote {len(ROSTER)} sheets for slots {", ".join(sorted(ROSTER))}'
          f' (+ roster.json)')

    # ---- COVERAGE AUDIT ------------------------------------------------------
    # Which engine clips each costume actually has DRAWINGS for, versus which are
    # being substituted from another pose. A substitution is not an error — the
    # game runs — but it is the list of art still to draw, and it should never be
    # something you have to discover by watching the game.
    WANT = {
        'neutral':  'IDLE loop (numbered) / JUMP_SQUAT / LAND / anchor',
        'walk':     'WALK_F + WALK_B',
        'punch':    'ATK_5P active frames',
        'kick':     'ATK_5K active frames',
        'jump':     'JUMP_RISE + JUMP_FALL',
        'soft-hit': 'HIT_STAND (punch reaction)',
        'hard-hit': 'HIT_STAND_HARD (kick reaction)',
        'block':    'BLOCK_STAND / BLOCK_CROUCH / BLOCK_AIR',
        'ko':       'KO (thrown, in the air)',
        'fallen':   'KNOCKDOWN (where the KO lands)',
        'win':      'WIN (the celebration)',
    }
    print('\ncoverage — drawings present per costume:')
    for costume in sorted(groups):
        have = groups[costume]
        base = {k.rsplit('-', 1)[0] if re.search(r'-\d+$', k) else k for k in have}
        if 'hit' in base and 'soft-hit' not in base:
            base.add('soft-hit')   # the alias above
            print(f'  ~ {costume}: using "hit" as the soft reaction '
                  f'(canonical name is "soft-hit")')
        missing = [k for k in WANT if k not in base]
        n = lambda pre: sum(1 for k in have
                            if k == pre or re.match(rf'^{re.escape(pre)}-\d+$', k))
        line = '  '.join(f'{k}:{n(k)}' for k in WANT if k in base)
        print(f'  {costume:16} {line}')
        if missing:
            for k in missing:
                print(f'      MISSING {k:9} -> {WANT[k]} (substituted)')
    print()
    return 0

sys.exit(main())
