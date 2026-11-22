// A git install (`dsh plugin add github:...`, `npm i git+https://...`) does not
// run `prepublishOnly`, and `dist/` is gitignored, so the package would install
// without its entry point and fail with ERR_MODULE_NOT_FOUND (review ur6-deps).
//
// Build only when the entry point is missing: `npm install` in a checkout that
// already has a fresh `dist/` should not pay for a rebuild, and `npm pack
// --ignore-scripts` skips this entirely.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/**
 * Build what the manifest promises and the tree does not have.
 *
 * Both halves are checked: a git install that gets `dist/` but no
 * `lib/client.js` installs a package whose `./client` export points at nothing,
 * and the host throws on a missing client entry rather than skipping the page.
 */
function build(args, what) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.error(`prepare-build: no ${what} and the build failed; a git install would be unloadable`)
    process.exit(result.status ?? 1)
  }
}

if (!existsSync('dist/index.js')) build(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], 'dist/index.js')
if (!existsSync('lib/client.js')) build(
  ['node_modules/vite/bin/vite.js', 'build', '--config', 'ui/vite.config.ts', '--mode', 'client'],
  'lib/client.js',
)
