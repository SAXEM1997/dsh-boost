/**
 * Ticket T1 (spec #2): the client half's artifact, tested as a FILE.
 *
 * Seam S-2 from the spec. The assertions are behavioural rather than textual:
 * the bundle is EXECUTED against a stand-in for the host's module loader, which
 * is the only thing that answers "will this file load in the settings page?".
 * A regex over the source can be satisfied by a file that still throws on load.
 *
 * The bundle is built into a temporary directory rather than `lib/`, so this
 * test neither depends on `npm run build` having run first nor repairs the
 * committed artifact it is inspecting.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

const root = new URL('..', import.meta.url).pathname

/** Specifiers that must resolve through the host's frozen module table. */
function isReactSpecifier(specifier: string): boolean {
  return specifier === 'react' || specifier.startsWith('react/') || specifier.startsWith('react-dom')
}

/** What the host's loader hands a bundle: `{ id, chunk, factory }`. */
interface Registration {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/**
 * Builds the client bundle into a fresh directory and returns its text.
 *
 * `BOOST_CLIENT_OUT_DIR` is the config's redirect (see `ui/vite.config.ts`);
 * without it the build would write `lib/client.js` in place.
 */
async function buildBundle(): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'boost-client-'))
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
        'build',
        '--config',
        join(root, 'ui', 'vite.config.ts'),
        '--mode',
        'client',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        // `NODE_ENV=test` is the hostile case, not an accident: vite picks the
        // JSX transform from NODE_ENV at BUILD TIME, and a test runner or a dev
        // shell sets it to `test`/`development`. Left at the ambient value the
        // build happens to be production and the dev-runtime assertion below
        // would pass for the wrong reason.
        env: { ...process.env, NODE_ENV: 'test', BOOST_CLIENT_OUT_DIR: outDir },
      },
    )
    assert.equal(result.status, 0, `vite build failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`)
    return await readFile(join(outDir, 'client.js'), 'utf8')
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}

/**
 * Runs the bundle the way the host does: a global `__ModuleLoader__` that
 * captures the registration, and a `require` that records what was asked for.
 *
 * The `require` stub throws on an unknown specifier, which is what the host's
 * frozen module table does — so a bundle that asks for something the shell does
 * not carry fails here, not in the settings page.
 */
function loadBundle(bundle: string): {
  registration: Registration
  requested: string[]
  exports: Record<string, unknown>
} {
  const requested: string[] = []
  const registrations: Registration[] = []
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(registration: Registration) {
          registrations.push(registration)
        },
      },
    },
    // Enough of a document for the style injection: the bundle appends a
    // `<style>` node to the host's head when it is applied.
    document: {
      createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
      head: { append() {} },
    },
    console: { warn() {}, error() {} },
  })
  vm.runInContext(bundle, context)

  assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
  const registration = registrations[0]!
  const loaded = registration.factory((specifier: string) => {
    requested.push(specifier)
    if (isReactSpecifier(specifier)) return {}
    throw new Error(`Cannot find module '${specifier}'`)
  })
  return { registration, requested, exports: loaded }
}

test('client bundle registers under the package name the host expects', async () => {
  const bundle = await buildBundle()
  const { registration } = loadBundle(bundle)
  // `id` must match the graph row being executed, which is the package name —
  // so it is read from `package.json` rather than restated here. The build's own
  // copy of the name lives in `ui/vite.config.ts`; a rename that misses it fails
  // this assertion instead of passing silently.
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string }
  assert.equal(registration.id, manifest.name)
})

test('client bundle exposes apply and inject to cordis', async () => {
  const bundle = await buildBundle()
  const { registration } = loadBundle(bundle)
  const exports = registration.factory(() => ({}))
  assert.equal(typeof exports['apply'], 'function')
  // Spread into this realm: the bundle's array comes from the vm context and
  // carries that context's `Array.prototype`, which `deepEqual` distinguishes.
  assert.deepEqual([...(exports['inject'] as string[])], ['slots'])
})

test('client bundle loads React through the host module table, never inlined', async () => {
  const bundle = await buildBundle()
  const { requested } = loadBundle(bundle)
  // The host's frozen module table is the ONLY place React comes from; a second
  // copy inside this file is a different React instance and breaks hooks.
  assert.ok(
    requested.some(isReactSpecifier),
    `the bundle never asked the host for React (asked for: ${requested.join(', ') || 'nothing'})`,
  )
  // React's own source defines these symbols; externalised, nothing here does.
  assert.doesNotMatch(bundle, /Symbol\.for\(\s*["'`]react\./)
})

test('client bundle never asks for the dev JSX runtime', async () => {
  const bundle = await buildBundle()
  const { requested } = loadBundle(bundle)
  // A dev-mode build emits `react/jsx-dev-runtime`, which the host's module
  // table does not carry: the file loads in a stub and throws in the settings
  // page. The build must be production for the JSX TRANSFORM, not merely for
  // the `define` substitution.
  assert.deepEqual(
    requested.filter((specifier) => specifier.includes('jsx-dev-runtime')),
    [],
  )
})

/** What `apply` did to the host's slots service, recorded in call order. */
interface SlotCalls {
  injected: string[]
  registered: { options: Record<string, unknown>; component: unknown }[]
}

/**
 * Runs `apply` against a stand-in for the shell's slots service.
 *
 * This is the registration CONTRACT, which the artifact test above cannot see:
 * the bundle can load perfectly and still claim a seat nowhere. The stand-in
 * mirrors the host's shape (`inject(key, callback)` returning a disposer,
 * `register(options, component)` returning a disposer) — see
 * `dsh-client-ui-settings/src/client/contract/slots.ts` for the slot side.
 */
function applyToFakeShell(bundle: string): SlotCalls {
  const calls: SlotCalls = { injected: [], registered: [] }
  const slots = {
    inject(key: string, callback: () => () => void): () => void {
      calls.injected.push(key)
      return callback()
    },
    register(options: Record<string, unknown>, component: unknown): () => void {
      calls.registered.push({ options, component })
      return () => {}
    },
  }
  const { exports } = loadBundle(bundle)
  const apply = exports['apply'] as (ctx: unknown) => void
  apply({ slots, effect: (callback: () => () => void) => callback() })
  return calls
}

test('client bundle claims a seat in the settings section with the agreed identity', async () => {
  const bundle = await buildBundle()
  const calls = applyToFakeShell(bundle)
  assert.deepEqual(calls.injected, ['settings.section'])
  assert.equal(calls.registered.length, 1)
  const options = calls.registered[0]!.options
  // The nav item's key, the seat's identity and its order are all contract:
  // T5 changes the label's TEXT, never these three.
  assert.equal(options['name'], 'settings.section')
  assert.equal(options['id'], 'boost')
  assert.equal(options['order'], 50)
  assert.equal(typeof options['label'], 'function')
  assert.equal(typeof calls.registered[0]!.component, 'function')
})

test('client bundle still loads when the shell has no slots service', async () => {
  const bundle = await buildBundle()
  const { exports } = loadBundle(bundle)
  const apply = exports['apply'] as (ctx: unknown) => void
  // A partial shell must cost the page, never the plugin: `apply` returning is
  // the whole contract here, and the warn is what an operator greps for.
  assert.doesNotThrow(() => apply({ effect: (callback: () => () => void) => callback() }))
})
