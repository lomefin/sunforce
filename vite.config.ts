import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // RELATIVE, so the build runs from wherever it is served rather than only
  // from a domain root. GitHub Pages puts the game at /<repo>/, and an
  // unzipped copy can sit in any folder; './' covers both.
  //
  // The art and audio loaders already cope: gfx/texture.ts resolves paths
  // against `document.baseURI` and audio/load.ts uses a relative 'audio/'
  // root, so only the script and style tags needed telling.
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, open: true },
  build: {
    target: 'es2022',
    // Off for the shipped build: a 1 MB .map next to a 167 kB bundle is dead
    // weight for players. `npm run dev` has full sourcemaps regardless.
    sourcemap: false,
  },
})
