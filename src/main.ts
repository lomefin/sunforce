// =============================================================================
// SunForce — src/main.ts
//
// The boot path, and nothing else. index.html owns the DOM shell (#game, #boot,
// #fatal); this file creates the GL context, preloads what the first frame
// needs, installs input and audio, and hands control to the scene system.
//
// It deliberately owns NO game logic. The match lifecycle (sim state + skins)
// lives in src/game/match.ts and the scenes in src/game/scenes.ts, so that a
// scene can transition to another scene without main.ts being involved.
// =============================================================================

import type { PlayerIx } from '@/core/contracts';
import { CharId, StageId } from '@/core/contracts';
import { REGISTRY } from '@/data/registry';
import { createGlHost, showFatal } from '@/gfx/gl';
import { createRenderer } from '@/gfx/renderer';
import { backdropSpecOf } from '@/gfx/stage';
import { acquireTexture, assetUrl } from '@/gfx/texture';
import { attachDebugHotkeys } from '@/gfx/debugdraw';
import { keyboardPair } from '@/input/sources';
import { createAudioGraph } from '@/audio/graph';
import { createAudioLoader } from '@/audio/load';
import { createMusicPlayer } from '@/audio/music';
import { createSceneMusic } from '@/audio/scene-music';
import { startLoopWith } from '@/core/loop';
import { DEFAULT_MATCH, makeMatchConfig } from '@/game/match';
import type { SceneMusic } from '@/audio/scene-music';
import { activeMatch, attachSelectHotkey, createBootScene } from '@/game/scenes';

/** The fight the game boots into. `[` opens the selector to change it. */
const BOOT_MATCH = makeMatchConfig({
  chars: [CharId.A, CharId.B],
  stage: StageId.STAGE_1,
});

const hideBoot = (): void => {
  const boot = document.getElementById('boot');
  if (boot === null) return;
  boot.classList.add('fade');
  window.setTimeout(() => boot.setAttribute('hidden', ''), 520);
};

const boot = async (): Promise<void> => {
  const host = createGlHost({ maxDpr: 2, autoResize: true });

  const renderer = createRenderer();
  await renderer.init(host.gl);
  renderer.resize(host.cssW, host.cssH, host.dpr);
  host.onResize((w, h, dpr) => renderer.resize(w, h, dpr));

  // Preload the stage art BEFORE clearing the boot screen. The backdrop is
  // created lazily on the first draw and falls back to flat bands until its
  // texture decodes — for a multi-megabyte panorama that is several visible
  // seconds of placeholder. acquireTexture refcounts by URL, so the renderer's
  // own later acquire is a cache hit, not a second fetch.
  // assetUrl, because gfx/texture.ts keys its cache on the STRING it is handed
  // and StageBackdrop acquires the ABSOLUTE url. Preloading the relative path
  // warmed a different entry and the panorama was uploaded to the GPU twice.
  await acquireTexture(
    host.gl, assetUrl(backdropSpecOf(REGISTRY.stages[BOOT_MATCH.stage]!).image),
  );

  const { sources } = keyboardPair();
  attachDebugHotkeys(window);
  attachSelectHotkey(window);

  // --- audio -----------------------------------------------------------------
  // Browsers keep an AudioContext suspended until the user interacts with the
  // page, so the track starts on the first keypress, not on load. Everything
  // here is optional: no Web Audio, or no file on disk, means silence and one
  // console warning — never a failed boot.
  const graph = createAudioGraph();
  let sceneMusic: SceneMusic | undefined;
  if (graph !== null) {
    graph.resumeOnGesture(window);
    const loader = createAudioLoader(graph.buses.ctx);
    const music = createMusicPlayer(graph, loader);
    // main.ts no longer chooses a track. The scenes do: the fight asks for its
    // stage's theme, the select screen asks for 'select', and the facade
    // cross-fades between them. Starting the stage track here as well would
    // play two at once on the boot fight.
    sceneMusic = createSceneMusic(graph, music);
    (window as unknown as Record<string, unknown>).sunforceAudio = {
      graph, loader, music, sceneMusic,
    };
  }

  // Skins are NOT awaited here. `match.prime()` installs the procedural stick
  // skin synchronously and swaps in each sprite sheet as it resolves, so a slow
  // or missing sheet delays nothing and never blocks the first frame.
  startLoopWith(
    createBootScene({ gl: host.gl, renderer, registry: REGISTRY, music: sceneMusic }, BOOT_MATCH),
    sources,
  );

  // Warm the select-screen portraits in the BACKGROUND, after the fight is
  // already running. They are ~10 MB across eight files and load lazily on the
  // select screen's first draw, which showed as ~10 s of placeholder letters
  // the first time '[' was pressed. Not awaited: boot must not wait on UI art
  // for a screen the player may never open.
  void (async () => {
    const { preloadPortraits } = await import('@/ui/select');
    await preloadPortraits(host.gl);
    // The troupe panoramas, for the same reason: the backdrop swaps when the
    // opponent's troupe brings its own art, and a 2.8 MB PNG decoded on the
    // first frame of a fight is a black screen with a countdown over it.
    // Refcounted by URL, so this is a warm cache and not a second copy.
    const { TROUPE_THEMES, stageForTroupe } = await import('@/data/troupes');
    const base = REGISTRY.stages[BOOT_MATCH.stage]!;
    for (const t of TROUPE_THEMES) {
      if (t.backdrop === undefined) continue;
      // Resolved the same way StageBackdrop resolves it, so this warms the very
      // entry the renderer will ask for rather than a near-miss beside it.
      await acquireTexture(host.gl, assetUrl(backdropSpecOf(stageForTroupe(base, t)).image));
    }
  })().catch(() => undefined);

  hideBoot();

  // Debug handle. Presentation only — nothing here is read by the simulation.
  (window as unknown as Record<string, unknown>).sunforce = {
    renderer,
    match: activeMatch,
    defaultMatch: DEFAULT_MATCH,
    get state() {
      return activeMatch()?.state ?? null;
    },
  };

  // eslint-disable-next-line no-console
  console.info(
    '[sunforce] P1: WASD move, R punch, T kick, G guard   |   ' +
      'P2: arrows, I punch, O kick, P guard   |   [ character select   |   F1 hitboxes',
  );
};

boot().catch((err: unknown) => {
  showFatal(err, 'boot');
  console.error('[sunforce] boot failed', err);
});

export type { PlayerIx };
