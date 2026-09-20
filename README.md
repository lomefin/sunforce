# SunForce

A 2D fighting game built around **Bolivian carnival dances** — Caporal, Tinku and
Diablada, the troupes of the Oruro and Arica carnivals.

Six fighters, 1000 HP each, best of three. Two players on one keyboard, or one
player against the CPU.

---

## Play it

**In a browser:** http://leonardo.luarte.cl/sunforce/
(also reachable at https://lomefin.github.io/sunforce/)

**From the zip:** download `sunforce-web.zip` from the
[Releases page](https://github.com/lomefin/sunforce/releases), unzip it, and read
the next section — it will *not* work by double-clicking `index.html`.

### Running the zip locally

The game is built as ES modules and fetches its art and audio, so browsers block
it on `file://` for security. Opening `index.html` directly gives a blank page
and a CORS error in the console. **It needs any local web server.** Pick one:

```bash
# Python 3 — already on macOS and most Linux
cd sunforce-web
python3 -m http.server 8000

# or Node, no install needed
npx serve sunforce-web

# or PHP
php -S localhost:8000 -t sunforce-web
```

Then open **http://localhost:8000**.

---

## Controls

Both players share one keyboard. There is no netplay.

| | Player 1 | Player 2 |
|---|---|---|
| Move / jump / crouch | `W` `A` `S` `D` | Arrow keys |
| Punch — 50 damage | `R` | `I` |
| Kick — 100 damage | `T` | `O` |
| Guard | `G` | `P` |
| Taunt | `Q` | `L` |

`[` opens the player-count and fighter select at any time. `F1` toggles the
hit / hurt / pushbox overlay.

No numpad anywhere — it all has to work on a laptop.

### Two things that surprise people

**The music starts on your first keypress, not on load.** Browsers keep audio
suspended until you actually interact with the page. It is not broken.

**The game boots straight into a fight.** Press `[` to pick fighters.

---

## The roster

Six characters, three troupes. They are deliberately close in frame data — the
differences are in reach, startup, recovery and weight, not in who is strongest.

| | Name | Troupe |
|---|---|---|
| A | Caporal | Caporal |
| B | Machona | Caporal |
| C | Macho Tinku | Tinku |
| D | Tinku Supay | Tinku |
| E | Diablo | Diablada |
| F | Virtud | Diablada |

The fight's music and backdrop follow the troupe of the fighter **on the right**,
so the stage answers whoever you are up against. Virtud has the one set of
physics that differs from the rest: she is drawn with wings, so she jumps
noticeably higher and hangs longer.

---

## Build it from source

### You need

| | Why |
|---|---|
| **Node 20+** | the dev server and the bundler |
| **Python 3** | `tools/build-sheets.py`, the art pipeline |
| **ImageMagick** 6 or 7 | trimming and packing the sprite atlases |

```bash
# macOS
brew install node python imagemagick

# Debian / Ubuntu
sudo apt install -y nodejs npm python3 imagemagick
```

### Then

```bash
git clone git@github.com:lomefin/sunforce.git
cd sunforce
npm install

npm run sheets     # REQUIRED FIRST — see below
npm run dev        # http://localhost:5173
```

### `npm run sheets` is not optional

Everything under `public/art/` — the sprite atlases, their JSON, the staged
backdrops and portraits — is **generated from `assets/` and is not in git**. A
fresh clone does not have it.

Skip this step and the build still succeeds, because Vite copies `public/`
verbatim rather than checking it. You get a game that boots to a black screen
with no fighters. If that happens, this is why.

The build prints a coverage table every run showing which clips each costume has
real drawings for and which are substituted from another pose. That table is the
list of art still to draw — it is meant to be read.

---

## Commands

| | |
|---|---|
| `npm run dev` | dev server on :5173, hot reload |
| `npm run sheets` | rebuild `public/art/` from `assets/` |
| `npm run verify` | typecheck + headless rule tests — **run before claiming done** |
| `npm run check` | the rule tests alone |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | typecheck + production build into `dist/` |
| `npm run preview` | serve `dist/` locally, exactly as deployed |

`npm run check` runs the whole simulation headlessly in Node — no browser, no
WebGL — because `step(state, in0, in1)` is a pure function over a flat
`Int32Array`. It asserts the actual game rules: punch 50, kick 100, ten kicks to
a KO, first hit never prorated, determinism over 200 frames, pushbox separation,
wall clamping, the countdown landing on each track's downbeat, and that every UI
string still fits the panel it is drawn in.

---

## Deploying

The build is plain static files — no server, no backend, no database. Anything
that can host a folder can host it.

**GitHub Pages** is wired up already: pushing to `main` runs
`.github/workflows/deploy.yml`, which installs ImageMagick, rebuilds the art,
builds the site and publishes it. You need to enable it once, in
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

**Anywhere else** — Netlify, Vercel, Cloudflare Pages, itch.io — run
`npm run sheets && npm run build` and upload `dist/`. `vite.config.ts` sets
`base: './'`, so it works at a domain root or in a subfolder without changes.

For **itch.io**, zip the *contents* of `dist/`, tick "This file will be played in
the browser", and set the viewport to 1280×720 to match the canvas.

### A note on size

The build is around **78 MB**, almost all of it painted backdrops, sprite
atlases and music. Roughly 12 MB of that is currently dead weight that nothing
references and which you can delete from `public/audio/music/` and
`assets/backgrounds/` if you want a smaller download:

```
stage-1-old.mp3   5.4 MB   superseded
stage-2.mp3       3.4 MB   no stage uses it
stage-3.png       2.8 MB   no stage definition points at it
```

The atlases are the rest. Converting them to WebP would cut them hard, but the
sheet loader expects `.png`, so that is a pipeline change rather than a setting.

---

## How it is put together

TypeScript + WebGL2 + Vite. No game framework, no physics library, no ECS.

The simulation is **deterministic fixed-point integer maths** — `ONE = 256`, and
every multiply truncates the same way — so the same inputs always produce the
same fight, on any machine. It never touches the DOM, floats, or the clock. That
is what makes `npm run check` possible: the rules can be tested without a browser
anywhere in sight.

Rendering is sprite blitting: one image per animation frame, one quad, no bones
at runtime. Characters are anchored on the sole when grounded and on the head
when airborne, and each costume derives its own scale so that all six are exactly
the same height in world units regardless of how the art was drawn.

Deeper notes live in `docs/` — `ENGINE-DECISIONS.md` for why the sim is shaped
the way it is, `CHARACTER-SPEC.md` for the stance and sprite rules, and
`CLAUDE.md` at the root for the conventions the whole project follows.

---

## Art

`assets/` holds the source art and is the only thing in this repository that
cannot be regenerated. Frames are named `<costume>-<clip>.png`, or
`<costume>-<clip>-<n>.png` for a numbered series:

```
assets/movements/     fight frames      male-tinku-walk-3.png
assets/portraits/     select screen     male-tinku-selector.png
assets/backgrounds/   stage panoramas   stage-tinku.png
```

Drop a file in, run `npm run sheets`, and it ships. Numbered neutrals become the
idle breathing loop; numbered jumps are split into rise and fall. Backdrops must
be **3:1** (2172×724 today) because the stage geometry assumes it.
