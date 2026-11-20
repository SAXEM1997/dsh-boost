#!/usr/bin/env node
/**
 * Remove `dist/` before a build.
 *
 * `tsc` never deletes output for a source file that has been renamed or
 * removed, so a stale `.js`/`.d.ts` pair would survive in the published
 * tarball. Doing this in Node instead of `rm -rf` keeps `npm run build`
 * working on Windows and on shells without a POSIX `rm`.
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(root, 'dist'), { recursive: true, force: true })