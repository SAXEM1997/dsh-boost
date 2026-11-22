/**
 * The build for the plugin's CLIENT half.
 *
 * Two modes share one config:
 *
 *  - `build:client` (`--mode client`) emits `lib/client.js`, the published
 *    artifact. It is a single-file CJS module wrapped in the host loader
 *    envelope `window.__ModuleLoader__.load({ id, factory })`.
 *
 *    CJS is load-bearing, not stylistic: the factory parameter is named
 *    `require` because that IS the host's module resolver, and only the CJS
 *    format emits `require("react")` calls. IIFE would emit bare identifiers
 *    that resolve to nothing at runtime.
 *
 *  - `dev` is a plain harness page (`ui/index.html`) for rendering the settings
 *    page in a browser without a host.
 *
 * No CSS file is emitted: the stylesheet is imported with `?inline` and
 * injected as a `<style>` node by the bundle entry, because the host's module
 * loader has no notion of a co-located stylesheet.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = dirname(fileURLToPath(import.meta.url))
const packageName = 'dsh-boost'

/**
 * The host loader envelope. `id` must match the graph row being executed, which
 * is this package's name.
 */
const loaderBanner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(packageName)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;`

const loaderFooter = `\t\treturn module.exports;
\t}
});`

export default defineConfig(({ mode }) => {
  const isClientBundle = mode === 'client'

  if (isClientBundle) {
    // MANDATORY, and NOT the same thing as the `define` below.
    //
    // vite decides `isProduction` from `process.env.NODE_ENV` at BUILD TIME and
    // picks the JSX transform accordingly: production emits
    // `require("react/jsx-runtime")`, anything else emits
    // `require("react/jsx-dev-runtime")` plus `jsxDEV` call sites. The host's
    // module table carries `react/jsx-runtime` and NO dev runtime, so a dev-mode
    // build loads fine in a stub and then throws in the settings page.
    //
    // `define` only substitutes output text; it does NOT steer the transform.
    // Setting it here is the one place that covers every entry point (a vitest
    // worker, a dev shell and CI all disagree about NODE_ENV).
    //
    // ASSUMPTION: one build per process. `vite build` is one process per
    // invocation, so the assignment below is applied before that build's
    // transform starts.
    process.env.NODE_ENV = 'production'
  }

  return {
    root: here,
    plugins: [react()],
    define: isClientBundle ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {},
    build: isClientBundle
      ? {
          // `BOOST_CLIENT_OUT_DIR` redirects the artifact so the artifact test
          // can build WITHOUT overwriting the committed `lib/client.js` it is
          // about to inspect — an in-place rebuild would repair the staleness
          // and then compare the repaired file with itself. Unset in every
          // normal build, so the published path is unchanged.
          outDir: process.env['BOOST_CLIENT_OUT_DIR'] ?? resolve(here, '..', 'lib'),
          emptyOutDir: false,
          // The host loads this file as a classic script through the module
          // loader, so it must be one self-contained CJS chunk — no code
          // splitting, no shared chunks, no hashed asset names.
          cssCodeSplit: false,
          minify: false,
          sourcemap: false,
          lib: {
            entry: resolve(here, 'src', 'main.tsx'),
            formats: ['cjs'],
            fileName: () => 'client.js',
          },
          rollupOptions: {
            // Every React entry point, externalized so the shell's single copy
            // is resolved through its `require` — a bundled second copy would
            // give this tree a different React instance and break hooks.
            //
            // The regexes are REQUIRED, not stylistic: the bare string `'react'`
            // matches only that exact specifier, so `react/jsx-runtime` (the
            // automatic JSX runtime the transform injects) would be silently
            // bundled.
            external: [/^react$/, /^react\//, /^react-dom$/, /^react-dom\//],
            output: {
              banner: loaderBanner,
              footer: loaderFooter,
            },
          },
        }
      : undefined,
  }
})
