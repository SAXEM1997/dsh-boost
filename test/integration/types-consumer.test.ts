/**
 * Row 33: the published type surface must not require a DOM lib.
 *
 * `src/types.ts` is reachable from `dist/index.d.ts`, and the package declares
 * no host dependencies. A consumer that compiles with `lib: ["ES2023"]` and
 * `types: []` (a Node-only project that deliberately avoids `@types/node` and
 * the DOM lib) must still be able to read the declarations. A bare
 * `AbortSignal` in `ToolActivationContext` fails that consumer with
 * `TS2304: Cannot find name 'AbortSignal'`, even though the plugin only ever
 * forwards the host's signal and never constructs one.
 *
 * The check compiles a copy of the source module under exactly that
 * environment, so it runs without a prior `npm run build` and fails on the
 * same token the published `dist/types.d.ts` would emit.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('row 33: types.ts compiles with lib ES2023 and types [] (no DOM AbortSignal)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-types-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  // A copy, not an import: the point is to compile the module exactly as it
  // ships, with no host tree and no ambient DOM declarations in scope.
  await writeFile(join(dir, 'types.ts'), await readFile(join(repoRoot, 'src', 'types.ts'), 'utf8'))
  await writeFile(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
          lib: ['ES2023'],
        },
        include: ['types.ts'],
      },
      null,
      2,
    )}\n`,
  )

  const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  try {
    await run(process.execPath, [tsc, '--noEmit', '-p', join(dir, 'tsconfig.json')], {
      cwd: dir,
    })
  } catch (error) {
    const detail = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`
    assert.fail(`the published types must not require a DOM lib:\n${detail.trim()}`)
  }
})
