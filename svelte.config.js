import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Svelte 5 compat shim — keep treating the codebase as Svelte 4.
// `componentApi: 4` makes `new App({ target })` in main.js work
// (Svelte 5's new default expects `mount(App, ...)` from 'svelte'
// instead). `runes: false` forces every file into legacy reactive
// mode regardless of script content, so the compiler doesn't
// auto-promote `$:` reactives in App.svelte to `$effect()` calls
// that fire during component construction and throw `effect_orphan`
// — that throw was surfacing to the user as the "Database Error"
// fallback in main.js (the catch was catching App's synchronous
// throw, NOT a real DB failure).
//
// `compatibility.componentApi` lives INSIDE `compilerOptions`, not
// as a sibling top-level key. (Hit that the first time around.)
//
// To migrate a single component to runes later, add
// `<svelte:options runes />` to that file.
export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    runes: false,
    compatibility: { componentApi: 4 },
  },
};
