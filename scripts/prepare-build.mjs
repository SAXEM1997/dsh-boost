// A git install (`dsh plugin add github:...`, `npm i git+https://...`) does not
// run `prepublishOnly`, and `dist/` is gitignored, so the package would install
// without its entry point and fail with ERR_MODULE_NOT_FOUND (review ur6-deps).
//
// Build only when the entry point is missing: `npm install` in a checkout that
// already has a fresh `dist/` should not pay for a rebuild, and `npm pack
// --ignore-scripts` skips this entirely.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

if (existsSync('dist/index.js')) process.exit(0)

const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (result.status !== 0) {
  console.error('prepare-build: no dist/index.js and the build failed; a git install would be unloadable')
  process.exit(result.status ?? 1)
}
