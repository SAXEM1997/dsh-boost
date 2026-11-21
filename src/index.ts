/**
 * dsh-boost cordis plugin entry point.
 *
 * The plugin is a plain function plugin: cordis reads `name` and `inject` from
 * the module and calls `apply(ctx, config)`. Only the production assembly lives
 * here — configuration resolution, the two stores the hooks and the control
 * tool share, the hook mounts, the lifecycle events that warm visibility,
 * drive the clock, flush receipts at turn end and clean up on session
 * disposal, and the `boost` tool, all wired once per plugin instance.
 *
 * Wiring failures are contained: a host that lacks the services a mount point
 * lives on must load the plugin with a warning, not die loading it. The data
 * root is `<dshHome>/boost` (`config.dshHome` when the row supplies it, else
 * `$DSH_HOME`), falling back to `~/.dsh/boost`.
 *
 * ## Why the mount disposers are dropped
 *
 * `ctx.on`, `ctx.systemPrompt.section` and `ctx.tools.register` all return a
 * disposer. Every one is deliberately discarded. A cordis plugin entry is
 * mounted in its own context, and disposing that entry tears down everything
 * registered through it; a retained disposer would add nothing except the
 * chance that a stale closure removes a mount owned by a later instance. The
 * assumption is exactly that per-entry ownership — if this plugin is ever
 * mounted into a context it does not own (a shared host context), the
 * disposers, or an explicit teardown, become required (review row 76).
 *
 * @module dsh-boost
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { measureBoostFixedOverhead } from './tools/boost.js'
import { RuntimeStepHorizon, StepBudget } from './admission/ledger.js'
import { RetrievalLedger } from './admission/retrieval.js'
import { UsageLedger } from './admission/usage.js'
import { resolveConfig } from './config.js'
import { AnchorStore } from './gate/invalidate.js'
import type { Plan } from './gate/plan.js'
import { resolveBoostRoot } from './host/root.js'
import { clearSession, SessionRuntime } from './hooks/llm-stream.js'
import { TurnClock } from './hooks/clock.js'
import { PendingQueue } from './hooks/pending.js'
import { clearAcceptedDispatch, registerHooks } from './hooks/post-execute.js'
import type { HookDeps, SelectorRoute } from './hooks/post-execute.js'
import type { SpillBackend } from './projection/apply.js'
import { ProjectionCounters } from './projection/counters.js'
import { PROTOCOL_NAME, PROTOCOL_TEXT } from './prompt/protocol.js'
import { ReceiptStore } from './receipts/store.js'
import type { LlmLike } from './selector/jev.js'
import { resolveWorkspace } from './scope/resolve.js'
import type { WorkspaceRegistry } from './scope/resolve.js'
import { ScopeStore } from './scope/store.js'
import { boostTool } from './tools/boost.js'
import type { BoostDeps, BoostHostFacts } from './tools/boost.js'
import type { PluginContext } from './types.js'

export const name = 'dsh-boost'

/**
 * Required host services.
 *
 * `llm` is deliberately absent: projection and admission use no model, and
 * only the selector does. A hard injection would leave the whole plugin
 * pending — no hooks, no tool, no warning — on a composition without the LLM
 * runtime, even though it could still project. The selector resolves `llm`
 * lazily and fails closed with `selector-unavailable` when it is absent.
 */
export const inject = ['tools', 'systemPrompt'] as const

/** Whether the host exposes both services the hook mounts attach to. */
function canRegister(ctx: PluginContext): boolean {
  return typeof ctx.on === 'function' && typeof ctx.systemPrompt?.section === 'function'
}

/** One-line detail for a contained wiring failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The dsh host line this build was verified against (`engines.dsh`). */
const VERIFIED_HOST_VERSION = '0.2.2-rc.4'

/**
 * Whether a reported version names the verified release, ignoring build
 * metadata.
 *
 * The host's compatibility preflight compares with
 * `semver.satisfies(version, range, { includePrerelease: true })`, and semver
 * ignores `+build` metadata on both sides. String equality would warn on
 * `0.2.2-rc.4+build.5` — a build the host itself accepts — so the comparison
 * strips everything from the first `+` (review row 34).
 */
function isVerifiedHostVersion(version: string): boolean {
  const core = (value: string): string => {
    const build = value.indexOf('+')
    return build === -1 ? value : value.slice(0, build)
  }
  return core(version) === core(VERIFIED_HOST_VERSION)
}

/** One parsed semantic version; build metadata is discarded. */
type SemVer = {
  major: number
  minor: number
  patch: number
  prerelease: readonly (string | number)[]
}

/**
 * Parse the semver subset a declared `engines.dsh` range uses.
 *
 * The host's compatibility preflight runs `semver.satisfies(..., {
 * includePrerelease: true })`. This module cannot import `semver` at runtime
 * (it is a dev dependency, and the published graph must stay host-free), so the
 * guard implements only what the manifest's range needs: `major.minor.patch`,
 * an optional prerelease, and the comparison operators. Anything else is
 * unparsable, and an unparsable range makes the guard advisory rather than
 * wrong.
 */
function parseSemVer(value: string): SemVer | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  )
  if (match === null) return undefined
  const majorText = match[1]
  const minorText = match[2]
  const patchText = match[3]
  if (majorText === undefined || minorText === undefined || patchText === undefined) {
    return undefined
  }
  const major = Number(majorText)
  const minor = Number(minorText)
  const patch = Number(patchText)
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return undefined
  }
  const prerelease: (string | number)[] = []
  const prereleaseText = match[4]
  if (prereleaseText !== undefined) {
    for (const identifier of prereleaseText.split('.')) {
      if (/^\d+$/.test(identifier)) {
        const numeric = Number(identifier)
        if (!Number.isSafeInteger(numeric)) return undefined
        prerelease.push(numeric)
      } else {
        prerelease.push(identifier)
      }
    }
  }
  return { major, minor, patch, prerelease }
}

/** Semver precedence for one prerelease identifier (numeric sorts first). */
function compareIdentifier(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'number') return -1
  if (typeof right === 'number') return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Semver precedence: negative when `left` is older, positive when newer. */
function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const delta = left[key] - right[key]
    if (delta !== 0) return delta
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  // A release outranks every prerelease of the same core version.
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    // A shorter identifier list is lower when every shared part is equal.
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const delta = compareIdentifier(leftPart, rightPart)
    if (delta !== 0) return delta
  }
  return 0
}

/**
 * Whether `version` satisfies `range`, or `undefined` when either cannot be
 * parsed.
 *
 * Supports the space-separated AND comparators (`>=`, `>`, `<=`, `<`, `=`, or
 * bare) and `||` alternatives. An unevaluable range is not a mismatch: the
 * guard is advisory, and warning on a range it does not understand would be
 * worse than staying quiet.
 */
function satisfiesRange(version: string, range: string): boolean | undefined {
  const parsed = parseSemVer(version)
  if (parsed === undefined) return undefined
  let evaluable = false
  for (const alternative of range.split('||')) {
    const comparators = alternative.trim().split(/\s+/).filter(token => token !== '')
    if (comparators.length === 0) continue
    let matched = true
    let valid = true
    for (const token of comparators) {
      const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token)
      const bound = match === null ? undefined : parseSemVer(match[2] ?? '')
      if (match === null || bound === undefined) {
        valid = false
        break
      }
      const order = compareSemVer(parsed, bound)
      const operator = match[1] ?? '='
      const satisfied =
        operator === '>='
          ? order >= 0
          : operator === '<='
            ? order <= 0
            : operator === '>'
              ? order > 0
              : operator === '<'
                ? order < 0
                : order === 0
      if (!satisfied) {
        matched = false
        break
      }
    }
    if (!valid) continue
    evaluable = true
    if (matched) return true
  }
  return evaluable ? false : undefined
}

/**
 * The `engines.dsh` range this build declares, read from the package manifest.
 *
 * The manifest is the one authority for "hosts this plugin accepts": the host's
 * preflight reads the same field, so a guard with a hard-coded range would drift
 * from the declaration it is supposed to enforce (review row 51). Memoised; a
 * missing or malformed manifest makes the guard advisory.
 */
let declaredHostRange: string | undefined | null = null

function declaredHostRangeOf(): string | undefined {
  if (declaredHostRange !== null) return declaredHostRange
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { engines?: { dsh?: unknown } }
    const range = manifest.engines?.dsh
    declaredHostRange = typeof range === 'string' && range.trim() !== '' ? range.trim() : undefined
  } catch {
    declaredHostRange = undefined
  }
  return declaredHostRange
}

/**
 * Stable host code: the resolved host version is not the verified one.
 *
 * A warning, never a hard failure: an unverified version is a risk, not proof
 * that an API this build uses has moved. It belongs to the `ERR_HOST_*` family
 * this module already logs (`ERR_HOST_NO_AGENT_REQUEST`,
 * `ERR_HOST_COMPLETE_SECTION`).
 */
const ERR_HOST_VERSION_MISMATCH = 'ERR_HOST_VERSION_MISMATCH'

/**
 * Stable host code: `system-prompt/assemble` was never observed.
 *
 * `ctx.on` accepts any string, so a renamed event registers successfully and
 * then never fires. This module needs assemble to warm the visibility cache
 * before section text resolves (design D4). The host runs assemble before
 * `agent/pre-step`, so the first pre-step without a single observed assemble is
 * proof the seam is gone. Raised once per process, on the first step that
 * needed it; the only signal is "never fired", so the event name also joins
 * `missingMounts`, and `status.degraded` reports `ERR_BOOST_PARTIAL_MOUNT`
 * (the per-event code is carried by the warning and the mount list, which is
 * the reachable status channel without a new status-side mapping).
 */
const ERR_HOST_NO_SYSTEM_PROMPT_ASSEMBLE = 'ERR_HOST_NO_SYSTEM_PROMPT_ASSEMBLE'

/**
 * Stable host code: `agent/pre-step` was never observed.
 *
 * Raised once, on the first main `llm/stream` request for a session whose step
 * clock was never driven. Without pre-step the turn is unknown, so every
 * pending substitution is abandoned; the warning says why instead of leaving
 * `status` healthy. Auxiliary (`purpose`-tagged) streams do not need the clock
 * and do not raise it. As with assemble, the event name joins `missingMounts`
 * and the per-event code is carried by the one-shot warning.
 */
const ERR_HOST_NO_AGENT_PRE_STEP = 'ERR_HOST_NO_AGENT_PRE_STEP'

/**
 * Stable host code: the selector route had to come from `agent/request`.
 *
 * `agent/pre-step` carries `modelSelection` and is the non-deprecated source.
 * When a host leaves it empty, the deprecated `agent/request` resolved config
 * is the only route left; the selector can still run, but the dependency is
 * reported once because that event is marked `@deprecated`. Absence of
 * `agent/request` itself is non-fatal and is reported separately by
 * `ERR_HOST_NO_AGENT_REQUEST`.
 */
const ERR_HOST_NO_MODEL_SELECTION = 'ERR_HOST_NO_MODEL_SELECTION'

/** The app-boot package whose version IS the dsh runtime version. */
const HOST_VERSION_PACKAGE = '@deepseek-ai/dsh-app-boot'

/** The host's package resolver (`pluginPackages` in a profile process). */
type PackageResolver = {
  packageOf?(specifier: string, parentURL: string): { version?: unknown } | undefined
}

/** Node's resolver, used only when the host service is unavailable. */
const requireFromHere = createRequire(import.meta.url)

/**
 * The resolved dsh host version, or `undefined` when it cannot be determined.
 *
 * `dsh-app-boot`'s own manifest is the runtime version the compatibility
 * preflight compares `engines.dsh` against, so it is the authority here too.
 * The profile's `pluginPackages` service is preferred because it resolves
 * through the same runtime interception the host used (a linked or mixed tree
 * reports the version actually loaded); a plain Node resolve from this module
 * is the fallback for an embedded composition without that service. Reading a
 * manifest is not a host import: the package is never loaded, and nothing in
 * `dist/` statically imports it.
 *
 * Never throws: an absent service, an unresolvable package and a malformed
 * manifest all mean "unknown", which is logged but not warned about.
 */
function hostVersionOf(ctx: PluginContext): string | undefined {
  try {
    const packages = serviceOf<PackageResolver>(ctx, 'pluginPackages')
    const pkg = packages?.packageOf?.(HOST_VERSION_PACKAGE, import.meta.url)
    if (typeof pkg?.version === 'string' && pkg.version !== '') return pkg.version
  } catch {
    // A foreign resolver is the same as no resolver.
  }
  try {
    const manifest = requireFromHere.resolve(`${HOST_VERSION_PACKAGE}/package.json`)
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Log the resolved host version once, warning only outside `engines.dsh`.
 *
 * The version guard is deliberately advisory. npm does not read `engines.dsh`;
 * the host enforces it only through the managed-install compatibility preflight,
 * which does not run for every composition. A warning here is the only signal
 * an embedded or mixed tree gets, and it must never stop the plugin: a version
 * this build did not verify may still work.
 *
 * The check is against the **declared range**, not exact equality (review row
 * 51): `engines.dsh` is `>=0.2.2-rc.4 <0.2.3-0`, and the host's preflight
 * accepts rc.5 and the 0.2.2 release. Warning on those told operators to
 * distrust a host the manifest itself accepts. Inside the range but not the
 * verified build is an informational note; outside it is the warning.
 */
function reportHostVersion(ctx: PluginContext): void {
  const version = hostVersionOf(ctx)
  const range = declaredHostRangeOf()
  if (version === undefined) {
    ctx.logger?.info?.(
      `dsh-boost: dsh host version unknown (verified against ${VERIFIED_HOST_VERSION}${range === undefined ? '' : `; declared range ${range}`}); compatibility cannot be checked`,
    )
    return
  }
  if (range === undefined) {
    ctx.logger?.info?.(
      `dsh-boost: dsh host ${version}; the package declares no engines.dsh range, so compatibility cannot be checked`,
    )
    return
  }
  const accepted = satisfiesRange(version, range)
  if (accepted === undefined) {
    ctx.logger?.info?.(
      `dsh-boost: dsh host ${version}; the declared range ${range} is not a semver range this guard understands, so compatibility cannot be checked`,
    )
    return
  }
  if (!accepted) {
    ctx.logger?.warn?.(
      `dsh-boost: ${ERR_HOST_VERSION_MISMATCH}: this build is verified against dsh ${VERIFIED_HOST_VERSION} (declared range ${range}), but the host reports ${version}, which is outside it; continuing, but a renamed host API may make the plugin inert`,
    )
    return
  }
  if (isVerifiedHostVersion(version)) {
    ctx.logger?.info?.(`dsh-boost: dsh host ${version} (verified)`)
    return
  }
  // Inside the range the manifest accepts, so this is not a mismatch — just not
  // the exact build the plugin was exercised against.
  ctx.logger?.info?.(
    `dsh-boost: dsh host ${version} is within the declared range ${range}, but not the exact build this was verified against (${VERIFIED_HOST_VERSION}); continuing`,
  )
}

/**
 * Duplicate applies observed in this process.
 *
 * The host exposes no stable duplicate-mount code for a prompt section, so the
 * only evidence is the plain Error's message. A throw counts as "this plugin is
 * already wired" only when that message names OUR section and says it is
 * already registered; every other failure is a wiring error with its own code
 * (see `isDuplicateSectionError`). The counter makes repeated applies visible
 * in the log without changing the mounts.
 */
let duplicateMountAttempts = 0

/**
 * Whether a section-registration throw is the host's genuine duplicate error.
 *
 * `dsh-system-prompt` builds a plain `Error` whose message starts with
 * `prompt section "<name>" is already registered` (global and scoped variants
 * both start that way) and exposes no code. The message alone proves only that
 * *some* plugin owns the name — another plugin using `dsh-boost` produces the
 * same text — so it is combined with {@link ownSectionRegistries}, the mount
 * marker this module owns (review row 32). A duplicate from a foreign owner is
 * a section-mount failure, not "this plugin is already wired": the remaining
 * hooks and the control tool must still mount.
 */
function isDuplicateSectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(`prompt section "${PROTOCOL_NAME}" is already registered`)
  )
}

/**
 * Read a soft host service through `ctx.get`.
 *
 * `workspaceRegistry`, `spillStore` and `tokenMeter` are optional peers: a
 * static injection would make the plugin fail to load on a host that does not
 * provide them, so they are fetched, never declared in `inject`. A host whose
 * `get` throws is the same as one without the service (the plugin-load test
 * pins that the data root is never resolved this way).
 */
function serviceOf<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    if (typeof ctx.get !== 'function') return undefined
    return ctx.get<T>(name) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * A memoising, retrying service getter with explicit invalidation.
 *
 * `ctx.get(name, strict=true)` answers `undefined` until the provider fiber is
 * ACTIVE, and cordis starts sibling plugin entries concurrently, so a service
 * read once in `apply` may simply not exist yet. A success is memoised; an
 * absence is never cached, because the provider may become active one tick
 * later. Every call site reads the getter, so the plugin recovers on the next
 * request instead of staying inert for the process lifetime.
 *
 * A first success is not a permanent binding (review row 6). `reset()` drops
 * the memo, and `refresh()` re-reads `ctx.get` and replaces the memo with the
 * current binding. Callers use `reset()` after a point-of-use failure (a
 * spill store whose `saveText` rejects, a registry whose `list()` throws, an
 * LLM whose stream fails); `refresh()` is the pre-write re-confirmation the
 * spill path needs, because a provider can be replaced between the decision
 * that resolved it and the write that uses it. `apply` also drops all three
 * memos when the owning cordis fiber unloads.
 */
type LazyService<T> = (() => T | undefined) & {
  reset(): void
  /** Re-read `ctx.get` and replace the memo with the current binding. */
  refresh(): T | undefined
}

function lazyService<T>(ctx: PluginContext, name: string): LazyService<T> {
  let resolved: T | undefined
  const get = (() => {
    if (resolved !== undefined) return resolved
    resolved = serviceOf<T>(ctx, name)
    return resolved
  }) as LazyService<T>
  get.reset = () => {
    resolved = undefined
  }
  get.refresh = () => {
    resolved = serviceOf<T>(ctx, name)
    return resolved
  }
  return get
}

/**
 * The cordis disposal seam (`ctx.effect`), optional for structural fake hosts.
 *
 * Cordis has no `dispose` event; a plugin owns its fiber and `ctx.effect`
 * registers a disposer that runs when that fiber unloads (`fiber.ts`: effects
 * are collected and run in reverse order on unload). The real context exposes
 * it on the proxy, but `PluginContext` stays the narrower structural host this
 * package can type without a cordis dependency, so the read is optional.
 */
type EffectContext = {
  effect?: (execute: () => () => void, label?: string) => unknown
}

/**
 * Run `invalidate` when the owning fiber unloads.
 *
 * Used for the three soft-service memos: a disposed provider must not leave a
 * stale binding behind for a later provider that reuses the same name (review
 * row 6). A host without the effect seam is not a failure: the point-of-use
 * resets still recover, only the disposal edge is missed.
 */
function onDispose(ctx: PluginContext, invalidate: () => void): void {
  try {
    const effect = (ctx as PluginContext & EffectContext).effect
    if (typeof effect !== 'function') return
    effect.call(ctx, () => invalidate, 'dsh-boost: soft service bindings')
  } catch {
    // A host that rejects the effect still gets the per-use resets.
  }
}

/**
 * The session id behind an agent or a `Session`.
 *
 * An agent exposes `session.header.id`; the `session/disposed` payload is the
 * `Session` itself and exposes `header.id` (and `id`). Anything else is
 * `undefined`, which makes every caller fail closed.
 */
function sessionIdOf(value: unknown): string | undefined {
  const carrier = value as
    | {
        session?: { header?: { id?: unknown } }
        header?: { id?: unknown }
        id?: unknown
      }
    | undefined
  const agentId = carrier?.session?.header?.id
  if (typeof agentId === 'string') return agentId
  const headerId = carrier?.header?.id
  if (typeof headerId === 'string') return headerId
  return typeof carrier?.id === 'string' ? carrier.id : undefined
}

/**
 * The host token meter's synchronous message estimator, resolved lazily.
 *
 * `ctx.tokenMeter` is a cordis service with a synchronous `estimateMessage`
 * method, so `ctx.get('tokenMeter')` is a real synchronous seam. Like every
 * soft service it may become active after this plugin's `apply`, so the
 * estimator is probed on first use and re-probed while absent; a success is
 * memoised. Presence is not capability: a service that throws or returns a
 * non-finite number is a broken meter, not a meter, and substitution is
 * refused exactly as when no service exists (review R5). A broken meter is not
 * memoised either, so a provider that finishes wiring its meter later can
 * still recover.
 *
 * The receipt label is `host` so the number is never mistaken for a provider
 * measurement; the only other label would be a fabricated `chars/4` fallback,
 * which this assembly deliberately does not implement.
 *
 * Memoisation covers the *binding*, not the answer. `kind()` probes the
 * memoised estimator on every call, because a meter that answered once is not
 * a meter forever: after it starts returning `NaN`, projection receipts already
 * record `estimate:'unknown'` for that assembly, and a cached `host` label
 * would contradict them in the same `boost status` output.
 */
const METER_PROBE = 'dsh-boost meter probe'

function meterSeamOf(ctx: PluginContext): {
  estimate(): ((text: string) => number) | undefined
  kind(): 'host' | 'unknown'
} {
  let estimator: ((text: string) => number) | undefined
  /** One probe through a raw host estimator; a throw or non-number is failure. */
  const probe = (estimate: (message: unknown) => number): boolean => {
    try {
      const value = estimate({
        role: 'user',
        content: [{ type: 'text', text: METER_PROBE }],
      })
      return typeof value === 'number' && Number.isFinite(value)
    } catch {
      return false
    }
  }
  const resolve = (): ((text: string) => number) | undefined => {
    if (estimator !== undefined) return estimator
    const meter = serviceOf<{ estimateMessage?: (message: unknown) => number }>(ctx, 'tokenMeter')
    if (meter === undefined || typeof meter.estimateMessage !== 'function') return undefined
    const estimate = meter.estimateMessage.bind(meter)
    if (!probe(estimate)) return undefined
    estimator = (text: string): number => {
      try {
        const value = estimate({ role: 'user', content: [{ type: 'text', text }] })
        return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
      } catch {
        return Number.NaN
      }
    }
    return estimator
  }
  return {
    estimate: resolve,
    kind: () => {
      const estimate = resolve()
      if (estimate === undefined) return 'unknown'
      // Probe through the memoised wrapper, so the label prices the same
      // pipeline every receipt uses. `resolve()` alone cannot answer: it
      // returns a cached binding even after the meter stopped answering.
      return Number.isFinite(estimate(METER_PROBE)) ? 'host' : 'unknown'
    },
  }
}

/** How many disposed session ids the runtime facade remembers (FIFO). */
const MAX_DISPOSED_RUNTIME_SESSIONS = 256

/**
 * `SessionRuntime` that refuses to recreate state for a disposed session.
 *
 * `clearSession` drops a session's runtime entry, but a `post-execute` that was
 * already in flight (a selector call can take 20 s) lands after disposal and
 * calls `clockFor`/`budgetFor`/`usageFor` again; the base class would create a
 * fresh entry nothing ever clears. The facade returns throwaway primitives for
 * disposed ids instead: the late hook records nothing, and the map cannot grow
 * after session end. The id set is FIFO-bounded so a long process cannot grow
 * it without limit.
 */
class DisposalAwareSessionRuntime extends SessionRuntime {
  private readonly disposed = new Set<string>()
  private readonly disposedOrder: string[] = []

  /** Mark a session disposed and drop whatever the base class still holds. */
  markDisposed(sessionId: string): void {
    this.clear(sessionId)
    if (this.disposed.has(sessionId)) return
    this.disposed.add(sessionId)
    this.disposedOrder.push(sessionId)
    while (this.disposedOrder.length > MAX_DISPOSED_RUNTIME_SESSIONS) {
      const oldest = this.disposedOrder.shift()
      if (oldest !== undefined) this.disposed.delete(oldest)
    }
  }

  override clockFor(sessionId: string): TurnClock {
    return this.disposed.has(sessionId) ? new TurnClock() : super.clockFor(sessionId)
  }

  override budgetFor(sessionId: string): StepBudget {
    return this.disposed.has(sessionId) ? new StepBudget(0) : super.budgetFor(sessionId)
  }

  override usageFor(sessionId: string): UsageLedger {
    return this.disposed.has(sessionId) ? new UsageLedger() : super.usageFor(sessionId)
  }

  override onModelRequest(sessionId: string, turn: number, step?: number): void {
    if (!this.disposed.has(sessionId)) super.onModelRequest(sessionId, turn, step)
  }
}

/** The `agent/request` payload fields this assembly reads. */
type RequestPayload = {
  agent?: unknown
  turn?: unknown
  step?: unknown
  /** Captured step route on `agent/pre-step` (also the selector's inheritance source). */
  modelSelection?: unknown
}

/**
 * Warm the synchronous visibility cache and remember the canonical workspace.
 *
 * `resolveWorkspace` is the async answer and also writes `scope.judgement(key)`;
 * it prefers the registry's `resolveByPath`, so a symlinked or trailing-slash
 * cwd resolves to the same id the judgement used. The workspace id is kept even
 * when the answer is "invisible", so the resolver must consult the live
 * judgement rather than treating the map as the answer. A workspace disabled
 * after a commit therefore stops resolving before the next synthesized turn.
 */
async function warmVisibility(
  scope: ScopeStore,
  registry: () => WorkspaceRegistry | undefined,
  agent: unknown,
  sessionId: string,
  workspaces: Map<string, string>,
): Promise<boolean> {
  try {
    const result = await resolveWorkspace(scope, agent, registry())
    // The map carries identity, `scope.judgement` carries visibility: cache the
    // id even when the answer is "invisible", and let the resolver combine the
    // two. A stale id therefore cannot outlive a visibility change.
    if (typeof result.workspaceId === 'string') workspaces.set(sessionId, result.workspaceId)
    else workspaces.delete(sessionId)
    return result.visible
  } catch {
    // `resolveWorkspace` is total; this contains a foreign registry.
    return false
  }
}

/** Remember the effective route the selector call must inherit. */
function rememberRoute(
  routes: Map<string, SelectorRoute>,
  sessionId: string,
  config: unknown,
): void {
  const resolved = config as
    | { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    | undefined
  if (resolved == null) return
  if (typeof resolved.provider !== 'string' || typeof resolved.model !== 'string') return
  const route: SelectorRoute = { provider: resolved.provider, model: resolved.model }
  if (typeof resolved.reasoningEffort === 'string') route.reasoningEffort = resolved.reasoningEffort
  routes.set(sessionId, route)
}

/**
 * Replace the protocol section's already-resolved text with the fresh answer.
 *
 * This runs *after* the assemble waterfall, so it rewrites text a section
 * provider already produced. That is deliberate and does not contradict D4
 * ("persistent, stable content"): every agent has its own prompt prefix and
 * its own context window, so changing this section cannot invalidate another
 * agent's cached prefix. Within one agent the answer changes only when its
 * resolved visibility changes (a workspace edit/`scope-set`), which is exactly
 * the point at which the prefix must change; every other assembly reproduces
 * the same bytes. The alternative — a section whose text is fixed at
 * registration — would either leak one agent's visibility to every other or
 * require a second provider to read a cache this listener has not warmed yet.
 */
function patchProtocolSection(assembly: unknown, visible: boolean): unknown {
  const value = assembly as { sections?: unknown } | undefined
  if (value === undefined || value === null || !Array.isArray(value.sections)) return assembly
  const sections = value.sections.map((section) => {
    const entry = section as { name?: unknown } | null
    return entry?.name === PROTOCOL_NAME
      ? { ...(entry as Record<string, unknown>), text: visible ? PROTOCOL_TEXT : '' }
      : section
  })
  return { ...(value as Record<string, unknown>), sections }
}

/** The marker every protocol text carries; a system prompt without it lost the section. */
const PROTOCOL_PROBE = '<CHISEL_PLAN>'

/**
 * The system-role text of one model request, or `undefined` when the request
 * carries no system prompt at all.
 *
 * Loop-built requests put the rendered prompt in the leading system-role
 * message (``GenerateOptions.messages``); one-shot callers use `system`. A
 * request with neither is a diagnostic that cannot tell us whether the section
 * landed, so it is not evidence of a complete-section swallow.
 */
function systemTextOf(options: unknown): string | undefined {
  const source = options as { messages?: unknown; system?: unknown } | null | undefined
  if (typeof source?.system === 'string' && source.system.length > 0) return source.system
  const messages = source?.messages
  if (!Array.isArray(messages)) return undefined
  let seen = false
  let text = ''
  for (const message of messages) {
    const entry = message as { role?: unknown; content?: unknown } | null
    if (entry?.role !== 'system') continue
    seen = true
    if (typeof entry.content === 'string') {
      text += entry.content
      continue
    }
    if (!Array.isArray(entry.content)) continue
    for (const block of entry.content) {
      const part = block as { type?: unknown; text?: unknown } | null
      if (part?.type === 'text' && typeof part.text === 'string') text += part.text
    }
  }
  return seen ? text : undefined
}

/**
 * Mount the host events the assembly owns.
 *
 * ## Why `system-prompt/assemble` owns the warm
 *
 * The host's preStep is `tools.resolve` -> `systemPrompt.assemble` ->
 * `agent/pre-step`; section text resolves inside `assemble`, and
 * `agent/request` fires only later in `step()`. A warm driven from
 * `agent/request` therefore misses request 1 (the gate can never act on step
 * 1) and then flips the system prompt on request 2, invalidating the whole
 * cached prefix (design D4). This listener runs inside the awaited assemble
 * waterfall, after sections resolve, with `context.scope` being the agent: it
 * warms the judgement and then rewrites our section's text from that fresh
 * answer. Request 1 is correct and request 2 reproduces the same bytes.
 *
 * The tool-level `when` was the alternative early seam; it is worse here
 * because it never runs when `tools.resolve` is unavailable or the boost tool
 * is filtered out, and it cannot await `resolveByPath` without making a
 * synchronous visibility predicate asynchronous. The assemble listener also
 * costs nothing on tool-listing paths.
 *
 * `agent/pre-step` is the non-deprecated clock seam (`agent/request` is
 * marked `@deprecated`); it fires once per proposed step with the host
 * `turn`/`step`, and it already carries the captured `modelSelection`. The
 * selector route is read from there first; `agent/request`'s resolved config
 * is only the compatibility path for a host whose pre-step does not populate
 * `modelSelection`, and it warns once when it is used. The visibility warm
 * stays at `assemble` (D4); `agent/pre-step` warms only when `assemble` never
 * fired, so no session's visibility depends on the deprecated event. A model
 * request that reaches `llm/stream` without any observed `agent/request` is
 * still reported once with `ERR_HOST_NO_AGENT_REQUEST`; the route itself does
 * not depend on it.
 *
 * ## Every mount is attributed
 *
 * `ctx.on` accepts any string (`cordis/src/events.ts`), so a renamed host
 * event registers successfully and then never fires. Registration failures and
 * "never observed" are therefore different signals, and both must reach the
 * operator:
 *
 * - Each listener is mounted in its own try/catch. A throw names that event in
 *   `missingMounts`, and the remaining listeners still mount. Before this, one
 *   bare catch around the whole wiring left `status.degraded` empty and lost
 *   `session/disposed` (per-session state leaked for the process lifetime).
 * - `ERR_HOST_NO_SYSTEM_PROMPT_ASSEMBLE` is raised once when the first
 *   `agent/pre-step` arrives without a single observed assemble. The host
 *   order guarantees assemble first, so its absence is a renamed/removed
 *   event. Its only evidence is "never observed"; the event name also joins
 *   `missingMounts`, so `status.degraded` reports `ERR_BOOST_PARTIAL_MOUNT`
 *   (the per-event code exists in the warning and the mount list).
 * - `ERR_HOST_NO_AGENT_PRE_STEP` is raised once when the first main
 *   `llm/stream` request arrives without any observed pre-step for that
 *   session. The step clock cannot advance without it, so substitution is
 *   impossible; auxiliary (`purpose`-tagged) streams do not need it and do not
 *   raise the warning.
 *
 * `session/event` (`turn/end`), `session/flush` and `session/disposed` call
 * `ReceiptStore.flush()` so the turn-end durability the design promises is
 * real. `session/disposed` also drops every per-session map the assembly owns
 * and tells the stores to evict their state.
 */
function wireSessionEvents(
  ctx: PluginContext,
  deps: HookDeps,
  scope: ScopeStore,
  registry: () => WorkspaceRegistry | undefined,
  sessions: DisposalAwareSessionRuntime,
  horizon: RuntimeStepHorizon,
  workspaces: Map<string, string>,
  routes: Map<string, SelectorRoute>,
  counters: ProjectionCounters,
  missing: Set<string>,
  ownsSection: boolean,
): void {
  /** Session ids seen at `agent/pre-step`; a `llm/stream` without a request is drift. */
  const preStepSeen = new Set<string>()
  /** Session ids observed on `agent/request`. */
  const requestSeen = new Set<string>()
  let assembleSeen = false
  let warnedMissingRequest = false
  let warnedCompleteSection = false
  let warnedNoAssemble = false
  let warnedNoPreStep = false
  let warnedRouteFallback = false

  /**
   * Mount one listener in its own try/catch.
   *
   * A failure names the event and is recorded in `missingMounts`; it never
   * stops the next listener. `true` means the registration itself succeeded,
   * which is not proof the host ever emits the event (see the never-observed
   * warnings below).
   */
  const mount = (
    event: string,
    handler: (...args: any[]) => unknown,
    options?: { prepend?: boolean },
  ): boolean => {
    try {
      ctx.on(event, handler, options)
      return true
    } catch (error) {
      missing.add(event)
      ctx.logger?.warn?.(
        `dsh-boost: ERR_BOOST_PARTIAL_MOUNT: ${event} mount failed (${messageOf(error)})`,
      )
      return false
    }
  }

  // `system-prompt/assemble` stays first: it is the seam that resolves the
  // section text every later step sees (design D4).
  const assembleMounted = mount('system-prompt/assemble', async (_assembly: unknown, context: unknown, next: () => unknown) => {
    assembleSeen = true
    const resolved = await next()
    try {
      // `dsh-agent` augments `AssembleContext` with the real `Agent`; `scope`
      // is an opaque `ScopeKey` and is never read as an Agent (review row 11).
      // A diagnostic assembly has no agent: the documented no-scope view, so
      // the section is suppressed and counted rather than keyed on a guess.
      const carrier = (context ?? {}) as { agent?: unknown }
      const agent = carrier.agent
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) {
        // The provider has nothing to key the judgement on and returns '';
        // clear the section explicitly so a stale provider answer cannot leak
        // into an assembly with no agent. Count the decision, not the
        // section's presence — design §5.5:378 asks for every assembly to be
        // judged.
        if (ownsSection) counters.protocolSuppressed()
        return ownsSection ? patchProtocolSection(resolved, false) : resolved
      }
      const visible = await warmVisibility(scope, registry, agent, sessionId, workspaces)
      // A foreign plugin owns the section name (row 32): warm the judgement the
      // decision path needs, but never rewrite another plugin's text.
      if (!ownsSection) return resolved
      // Same rule for an invisible workspace: the section is suppressed for
      // this assembly, so the operator gets a live signal in `boost status`.
      // A visible one never increments, so the count stays a failure count.
      if (!visible) counters.protocolSuppressed()
      return patchProtocolSection(resolved, visible)
    } catch {
      return resolved
    }
  })

  const preStepMounted = mount('agent/pre-step', async (payload: unknown, next: () => unknown) => {
    const request = (payload ?? {}) as RequestPayload
    const sessionId = sessionIdOf(request.agent)
    if (sessionId !== undefined) {
      preStepSeen.add(sessionId)
      // Row 8: assemble runs before pre-step in the host's own order. If it
      // has never run by the first step, the event was renamed or removed and
      // the protocol section cannot be warmed or patched.
      if (!assembleSeen && !warnedNoAssemble && assembleMounted) {
        warnedNoAssemble = true
        missing.add('system-prompt/assemble')
        ctx.logger?.warn?.(
          `${ERR_HOST_NO_SYSTEM_PROMPT_ASSEMBLE}: system-prompt/assemble was not observed before the first agent/pre-step; the protocol section cannot be warmed or patched (the event may have been renamed or removed)`,
        )
      }
      try {
        sessions.onModelRequest(
          sessionId,
          typeof request.turn === 'number' ? request.turn : Number(request.turn),
          typeof request.step === 'number' ? request.step : undefined,
        )
      } catch {
        // A clock that cannot be driven must not break the step.
      }
      try {
        horizon.observe(
          sessionId,
          typeof request.turn === 'number' ? request.turn : Number(request.turn),
          typeof request.step === 'number' ? request.step : Number(request.step),
        )
      } catch {
        // History is an estimate; a bad observation is not a step failure.
      }
      // `agent/pre-step` already carries the captured step selection. It is
      // the non-deprecated source for the selector route; `agent/request`'s
      // resolved config remains a compatibility fallback for hosts that only
      // populate it there. A later request overwrites with the same route.
      rememberRoute(routes, sessionId, request.modelSelection)
      // The warm belongs to `system-prompt/assemble` (D4). This is the
      // fallback for a host that skipped or renamed assemble: pre-step is the
      // non-deprecated seam, so visibility no longer depends on the
      // deprecated `agent/request` event.
      if (!assembleSeen) {
        await warmVisibility(scope, registry, request.agent, sessionId, workspaces)
      }
    }
    return next()
  })

  mount('agent/request', async (payload: unknown, next: () => unknown) => {
    const request = (payload ?? {}) as RequestPayload
    const sessionId = sessionIdOf(request.agent)
    if (sessionId !== undefined) {
      requestSeen.add(sessionId)
      // Compatibility only: when pre-step is present it already drove the
      // clock and the horizon. This branch exists for a host that still emits
      // the deprecated event but not the non-deprecated one.
      if (!preStepSeen.has(sessionId)) {
        try {
          sessions.onModelRequest(
            sessionId,
            typeof request.turn === 'number' ? request.turn : Number(request.turn),
            typeof request.step === 'number' ? request.step : undefined,
          )
        } catch {
          // A clock that cannot be driven must not break the model request.
        }
        try {
          horizon.observe(
            sessionId,
            typeof request.turn === 'number' ? request.turn : Number(request.turn),
            typeof request.step === 'number' ? request.step : Number(request.step),
          )
        } catch {
          // Same as the pre-step observation: history is an estimate.
        }
        if (!assembleSeen) {
          await warmVisibility(scope, registry, request.agent, sessionId, workspaces)
        }
      }
    }
    const config = await next()
    // Capability check (row 22): the non-deprecated pre-step carries
    // `modelSelection`; when it did, this event must not overwrite the route.
    // When it did not, the resolved config is the only source left, and the
    // deprecated path warns once.
    if (sessionId !== undefined && routes.get(sessionId) === undefined) {
      rememberRoute(routes, sessionId, config)
      if (routes.get(sessionId) !== undefined && !warnedRouteFallback) {
        warnedRouteFallback = true
        ctx.logger?.warn?.(
          `${ERR_HOST_NO_MODEL_SELECTION}: agent/pre-step carried no modelSelection; the selector route came from the deprecated agent/request event, which may be removed`,
        )
      }
    }
    return config
  })

  // The deprecated event's disappearance would otherwise disable the selector
  // route silently. A session that reached `llm/stream` after a pre-step but
  // never saw `agent/request` is proof enough; the model request itself is
  // passed through untouched. The route now comes from pre-step, so this is a
  // compatibility warning, not a correctness dependency.
  //
  // This listener is also the complete-section detector, and it MUST be
  // outermost: the synthesizer mounted by `registerHooks` consumes a queued
  // entry synchronously, so a detector registered after it would only mark the
  // session unsubstitutable *after* the first affected request had already been
  // substituted. Cordis runs the first-registered listener outermost
  // (`events.ts` unshifts on `prepend`), so `prepend: true` is what puts the
  // detector before the synthesizer regardless of mount order (finding 4).
  mount(
    'llm/stream',
    (options: unknown, next: () => unknown) => {
      try {
        const request = (options ?? {}) as { sessionId?: unknown; purpose?: unknown }
        const sessionId = request.sessionId
        // Row 8: a main request needs the step clock, which only pre-step
        // drives. An auxiliary (`purpose`) stream carries its own prompt and
        // never needs it, so it is not evidence the seam is missing.
        if (
          !warnedNoPreStep &&
          preStepMounted &&
          request.purpose === undefined &&
          typeof sessionId === 'string' &&
          !preStepSeen.has(sessionId)
        ) {
          warnedNoPreStep = true
          missing.add('agent/pre-step')
          ctx.logger?.warn?.(
            `${ERR_HOST_NO_AGENT_PRE_STEP}: agent/pre-step was not observed before the first main llm/stream request; the step clock cannot advance (the event may have been renamed or removed)`,
          )
        }
        if (
          !warnedMissingRequest &&
          typeof sessionId === 'string' &&
          preStepSeen.has(sessionId) &&
          !requestSeen.has(sessionId)
        ) {
          warnedMissingRequest = true
          ctx.logger?.warn?.(
            'ERR_HOST_NO_AGENT_REQUEST: agent/request was not observed before llm/stream; the deprecated event may have been removed (the selector route is captured from agent/pre-step modelSelection)',
          )
        }

        // A `complete: true` prompt section replaces every other section after
        // the assembly waterfall, so the protocol text
        // `system-prompt/assemble` patched in is gone from the request the
        // model actually receives. The host exposes no code or flag for that
        // restoration; the outgoing system prompt is the first place it is
        // observable. Detect it, count it, and fail closed: without the
        // protocol there is nothing to teach the plan grammar, so substitution
        // (and the projection that shares the same visibility gate) must not
        // act for this request (review row 12).
        //
        // Only a main-agent request is evidence. Every auxiliary stream — the
        // selector, compaction, and the default-on session-title provider —
        // sets `purpose` and carries its own summariser prompt, which never
        // contains the protocol section. Treating one as a swallow would count
        // a suppression that never happened, flip the session's cached
        // visibility off, and leave `ERR_HOST_COMPLETE_SECTION` in `status`
        // for the rest of the process (review row 1). This is the same rule the
        // synthesizer applies (`llm-stream.ts`: any `purpose` is auxiliary).
        if (
          request.purpose === undefined &&
          typeof sessionId === 'string' &&
          scope.judgement(sessionId)
        ) {
          const systemText = systemTextOf(options)
          if (systemText !== undefined && !systemText.includes(PROTOCOL_PROBE)) {
            counters.protocolSuppressed()
            counters.protocolMissing()
            scope.remember(sessionId, false)
            if (!warnedCompleteSection) {
              warnedCompleteSection = true
              ctx.logger?.warn?.(
                'ERR_HOST_COMPLETE_SECTION: the final system prompt does not carry the dsh-boost protocol section (a complete prompt section replaced the assembly); substitution is disabled for affected requests',
              )
            }
          }
        }
      } catch {
        // Detection must never break the model request.
      }
      return next()
    },
    { prepend: true },
  )

  // `session/event` carries a plain `type` string, so `turn/end` is matched by
  // value, not by a stable code. That match is a convenience: it flushes early
  // on the common path, but it is not the durability boundary. The host does
  // not await this listener, so a process exit immediately after `turn/end`
  // can drop the flush; the awaited `session/flush` below is what the
  // persistence contract rests on, and `session/disposed` flushes again after
  // the last hook for the id. Receipts are evidence, so an early flush that
  // does not happen costs latency, never correctness.
  mount('session/event', (_session: unknown, event: unknown) => {
    const type = (event as { type?: unknown } | undefined)?.type
    if (type === 'turn/end') {
      // Fire-and-forget on the real host; `flush()` never rejects.
      return deps.receipts.flush()
    }
    return undefined
  })

  mount('session/flush', () => deps.receipts.flush())

  mount('session/disposed', async (session: unknown) => {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return
    try {
      clearSession(deps, sessionId)
    } catch {
      // Session end owns no tool result; a failed clear must not throw here.
    }
    sessions.markDisposed(sessionId)
    workspaces.delete(sessionId)
    routes.delete(sessionId)
    requestSeen.delete(sessionId)
    preStepSeen.delete(sessionId)
    horizon.clear(sessionId)
    scope.forget(sessionId)
    // Flush this session's buffered lines before evicting its state, then make
    // every later hook for the id a no-op.
    try {
      await deps.receipts.flush()
    } catch {
      // Flush is total; a foreign store must not break session end.
    }
    deps.receipts.disposeSession(sessionId)
  })

  if (missing.size > 0) {
    ctx.logger?.warn?.(
      `dsh-boost: ERR_BOOST_PARTIAL_MOUNT: missing mount(s): ${[...missing].join(', ')}; the plugin is partially wired and boost status reports this code`,
    )
  }
}

/**
 * Register the `boost` tool family.
 *
 * After T19 the family is just this one tool. The tool itself is scope-exempt
 * (`when: () => true`) because it is the only way a user can enable a workspace
 * that is not enabled yet — gating it on the scope document would make
 * `selected + []` impossible to leave. The protocol section is not exempt; T17
 * already handles it.
 *
 * No step-`when` capability probe is needed: the condition is constant-true, so
 * a host that ignored the registration options would register it
 * unconditionally — exactly the behaviour this build wants. The old probe only
 * tested `typeof tools.register === 'function'`, which every host since
 * 0.2.2-rc.1 satisfies, so the branch it fed could never run; it was removed
 * rather than left as a claim that can never be false.
 */
function registerBoostTool(ctx: PluginContext, deps: BoostDeps): void {
  // Annotating with the host's ToolDefinition makes a host-side tightening a
  // build error instead of a runtime registration failure. The tool is
  // scope-exempt by design (`when: () => true`), so it needs no registry: the
  // registry is only the visibility warm's input, wired above.
  const definition: ToolDefinition = boostTool(deps)

  ctx.tools.register(definition, { when: () => true })
}

/**
 * Section registries this module successfully registered into.
 *
 * The mount marker this module owns (review row 32). The host's duplicate
 * message is generic: another plugin registering `dsh-boost` produces exactly
 * the same text. A duplicate therefore counts as "this plugin is already
 * wired" only when the same prompt registry object received this module's
 * section earlier in the process. A foreign owner is a section-mount failure:
 * the remaining hooks and the control tool still mount, and the foreign text
 * is never rewritten.
 */
const ownSectionRegistries = new WeakSet<object>()

/**
 * Prompt registries this module already mounted its hooks and tool against.
 *
 * Separate from {@link ownSectionRegistries}: a foreign section owner means
 * this module does not own the section text, but a second apply over the same
 * registry must still not mount the hooks twice. Marked once a non-duplicate
 * apply has finished mounting, and consulted only for the duplicate decision.
 */
const mountedRegistries = new WeakSet<object>()

/** What {@link mountHooks} established about the section and the other mounts. */
type MountOutcome = {
  /** A previous apply of this plugin owns the mounts; register nothing else. */
  alreadyMounted: boolean
  /** This apply registered the prompt section (so its text may be patched). */
  ownsSection: boolean
}

/** The mount label the prompt section reports when it cannot be registered. */
const MOUNT_SECTION = 'systemPrompt.section'

/** One event listener recorded by {@link mountHooks} before it is mounted. */
type DeferredMount = {
  event: Parameters<PluginContext['on']>[0]
  handler: Parameters<PluginContext['on']>[1]
  options?: Parameters<PluginContext['on']>[2]
}

/**
 * Mount the four integration points, attributing each failure.
 *
 * `registerHooks` mounts the prompt section first and aborts on its failure, so
 * handing it the real context would lose the three event mounts whenever the
 * section is rejected — while `apply` logged "continuing with the remaining
 * mounts" and `status` still reported `degraded: []` (review row 2). It is
 * called with a recording context instead: the section is registered
 * immediately (its duplicate check must happen before anything else is
 * mounted), a rejection is recorded rather than rethrown so `registerHooks`
 * still describes the three event mounts, and those are then mounted one by one
 * so a failure names the mount that failed and lands in `missing`.
 *
 * Returns `alreadyMounted` only when the section error is the host's
 * duplicate-registration error AND this module registered that same registry
 * earlier (the mount marker): a previous apply owns every mount and this one
 * must register nothing. A duplicate from another plugin is a section-mount
 * failure, so the remaining mounts still happen (review row 32).
 */
function mountHooks(ctx: PluginContext, deps: HookDeps, missing: Set<string>): MountOutcome {
  const deferred: DeferredMount[] = []
  let sectionError: unknown
  let registrationError: unknown

  const recording = {
    logger: ctx.logger,
    on(
      event: Parameters<PluginContext['on']>[0],
      handler: Parameters<PluginContext['on']>[1],
      options?: Parameters<PluginContext['on']>[2],
    ): void {
      deferred.push({ event, handler, options })
    },
    systemPrompt: {
      section(section: Parameters<PluginContext['systemPrompt']['section']>[0]): void {
        try {
          ctx.systemPrompt.section(section)
        } catch (error) {
          // Record, do not rethrow: `registerHooks` aborts on a throwing
          // section, and the other three mounts must still be described.
          sectionError = error
        }
      },
    },
  } as unknown as PluginContext

  try {
    registerHooks(recording, deps)
  } catch (error) {
    registrationError = error
  }

  let ownsSection = false
  const registry = ctx.systemPrompt as object | undefined
  if (sectionError !== undefined && isDuplicateSectionError(sectionError)) {
    if (registry !== undefined && mountedRegistries.has(registry)) {
      duplicateMountAttempts += 1
      ctx.logger?.warn?.(
        `dsh-boost: ERR_BOOST_ALREADY_MOUNTED: duplicate apply #${duplicateMountAttempts} found an existing mount; registration skipped (${messageOf(sectionError)})`,
      )
      return {
        alreadyMounted: true,
        ownsSection: registry !== undefined && ownSectionRegistries.has(registry),
      }
    }
    // The name is taken, but not by this module: the message alone cannot tell
    // our previous apply from another plugin using the same section name.
    missing.add(MOUNT_SECTION)
    ctx.logger?.warn?.(
      `dsh-boost: ERR_BOOST_SECTION_REGISTER_FAILED: prompt section "${PROTOCOL_NAME}" is registered by another plugin; mounting the remaining hooks independently (${messageOf(sectionError)})`,
    )
  } else if (sectionError !== undefined) {
    missing.add(MOUNT_SECTION)
    ctx.logger?.warn?.(
      `dsh-boost: ERR_BOOST_SECTION_REGISTER_FAILED: prompt section registration failed; mounting the remaining hooks independently (${messageOf(sectionError)})`,
    )
  } else {
    ownsSection = true
    // Record the marker only after the host accepted the section: this is the
    // one registry object a later duplicate may be attributed to.
    if (ctx.systemPrompt !== undefined && typeof ctx.systemPrompt === 'object') {
      ownSectionRegistries.add(ctx.systemPrompt)
    }
    if (registrationError !== undefined) {
      // The section did not throw, so this is an assembly bug: an unknown mount
      // is missing even though no specific one can be named.
      missing.add('hooks')
      ctx.logger?.warn?.(
        `dsh-boost: ERR_BOOST_PARTIAL_MOUNT: hook assembly failed (${messageOf(registrationError)})`,
      )
    }
  }

  for (const mount of deferred) {
    try {
      ctx.on(mount.event, mount.handler, mount.options)
    } catch (error) {
      missing.add(mount.event)
      ctx.logger?.warn?.(
        `dsh-boost: ERR_BOOST_PARTIAL_MOUNT: ${mount.event} mount failed (${messageOf(error)})`,
      )
    }
  }

  if (missing.size > 0) {
    ctx.logger?.warn?.(
      `dsh-boost: ERR_BOOST_PARTIAL_MOUNT: missing mount(s): ${[...missing].join(', ')}; the plugin is partially wired and boost status reports this code`,
    )
  }
  // A later apply over this registry is a duplicate even when the section name
  // belonged to another plugin: the hooks and the tool are ours either way.
  if (registry !== undefined) mountedRegistries.add(registry)
  return { alreadyMounted: false, ownsSection }
}

export function apply(ctx: PluginContext, config: unknown): void {
  const repairs: string[] = []
  const cfg = resolveConfig(config, message => {
    repairs.push(message)
    ctx.logger?.warn?.(message)
  })
  // The effective-config line serialises `resolveConfig`'s output, which never
  // carries `dshHome` (that override is resolved by `resolveBoostRoot`). Log
  // the resolved root with it, once, so the operator can see the state root in
  // use — including the `$DSH_HOME`/`~/.dsh` fallback and the cwd resolution of
  // a relative override.
  let root: string
  try {
    root = resolveBoostRoot(config)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-boost: cannot resolve the state root: ${messageOf(error)}`)
    return
  }
  // One line with the effective values (not only the keys this module happens
  // to use): an operator can see every clamp and fallback instead of guessing.
  ctx.logger?.info?.(
    `dsh-boost loaded (stepsPerTurn=${cfg.stepsPerTurn}, horizonSteps=${cfg.horizonSteps}); effective config=${JSON.stringify(cfg)}; root=${root}`,
  )
  if (repairs.length > 0) {
    ctx.logger?.info?.(`dsh-boost: ${repairs.length} configuration value(s) repaired`)
  }
  // The only version guard outside the managed-install preflight. Advisory:
  // an unverified host is a warning, never a refusal to load.
  reportHostVersion(ctx)

  if (!canRegister(ctx)) {
    ctx.logger?.warn?.('dsh-boost: host hook services unavailable; registration skipped')
    return
  }

  try {
    // The root was resolved above (D4) so the log can show it; both stores use
    // the same value. `resolveBoostRoot` is the only root rule (design §10), so
    // `apply` and the hook stores cannot diverge.
    const scope = new ScopeStore(root, { warn: (message: string) => ctx.logger?.warn?.(message) })
    const receipts = new ReceiptStore(root)
    const anchors = new AnchorStore()
    const queue = new PendingQueue()
    const plans = new Map<string, Plan>()
    const sessions = new DisposalAwareSessionRuntime(cfg.stepsPerTurn)
    const horizon = new RuntimeStepHorizon(cfg.horizonSteps, cfg.historyTurns)
    const retrievals = new RetrievalLedger()
    /** Session id → workspace id, populated by the visibility warm. */
    const workspaces = new Map<string, string>()
    /** Session id → the route the selector call inherits. */
    const routes = new Map<string, SelectorRoute>()

    // Soft host services. Cordis activates sibling providers concurrently, so
    // these getters retry until the provider fiber is ACTIVE; an absence is
    // never memoised. The workspace registry is the `resolveByPath`/`list()`
    // seam; the spill store is the projection backend; the token meter prices
    // projections and admission. A first success is not a permanent binding:
    // each point of use resets the memo on failure, and the plugin's fiber
    // disposal drops all three (review row 6).
    const registry = lazyService<WorkspaceRegistry>(ctx, 'workspaceRegistry')
    const spillService = lazyService<SpillBackend>(ctx, 'spillStore')
    // `llm` is soft (see `inject`): projection and admission never need it, and
    // the selector checks it at call time. A getter keeps a provider that
    // becomes active after `apply` reachable on the next decision.
    const llm = lazyService<LlmLike>(ctx, 'llm')

    /**
     * The workspace registry the visibility warm uses, with a failure re-probe.
     *
     * `list()` and `resolveByPath()` are total in the resolver (they swallow
     * their own throws), so this wrapper is the only place a replaced or
     * disposed provider is observable. A throw drops the memo; the next warm
     * asks `ctx.get` again and picks up the live binding.
     */
    const registryBackend = (): WorkspaceRegistry | undefined => {
      const backend = registry()
      if (backend === undefined) return undefined
      const resolveByPath = backend.resolveByPath
      const wrapper: WorkspaceRegistry = {
        list: () => {
          try {
            return backend.list()
          } catch (error) {
            registry.reset()
            throw error
          }
        },
      }
      if (typeof resolveByPath === 'function') {
        wrapper.resolveByPath = async (path) => {
          try {
            return await resolveByPath.call(backend, path)
          } catch (error) {
            registry.reset()
            throw error
          }
        }
      }
      return wrapper
    }

    /**
     * The spill backend the decision path uses, with a pre-write re-confirmation.
     *
     * A store that resolved is not a store that still exists: the provider may
     * be replaced or disposed between the decision that resolved it and the
     * write. Every write re-reads `ctx.get` through `refresh()` and uses the
     * current binding. A rejection drops the memo too, so a dead backend cannot
     * keep every later projection pointed at it while `hasSpill` stays true
     * (review rows 6 and 31).
     */
    const spillBackend = (): SpillBackend | undefined => {
      if (spillService() === undefined) return undefined
      return {
        saveText: async (input) => {
          const current = spillService.refresh()
          if (current === undefined) {
            // The store disappeared mid-turn: the projection path records this
            // as `projection-skipped:spill-failed`, not as a crash.
            throw new Error('spillStore disappeared before the write')
          }
          try {
            return await current.saveText(input)
          } catch (error) {
            spillService.reset()
            throw error
          }
        },
      }
    }

    /**
     * The LLM seam the selector uses, with a failure re-probe.
     *
     * The selector turns any failure into an abstention, so a provider that is
     * replaced after one successful call would otherwise be used for the rest
     * of the process. A synchronous throw or a throw while the stream is
     * consumed drops the memo; the next selection asks `ctx.get` again.
     */
    const llmBackend = (): LlmLike | undefined => {
      const backend = llm()
      if (backend === undefined) return undefined
      return {
        stream: (options) => {
          try {
            const stream = backend.stream(options)
            return (async function* () {
              try {
                yield* stream
              } catch (error) {
                llm.reset()
                throw error
              }
            })()
          } catch (error) {
            llm.reset()
            throw error
          }
        },
      }
    }

    // A disposed provider must not leave a stale binding behind for a later
    // provider that reuses the name. Cordis has no `dispose` event; the effect
    // seam is the fiber-unload hook (see `onDispose`).
    onDispose(ctx, () => {
      registry.reset()
      spillService.reset()
      llm.reset()
    })

    const meter = meterSeamOf(ctx)
    const projectionCounters = new ProjectionCounters()

    // Host capabilities `status` renders as stable codes. Getters keep them
    // facts about the host *now*: a service that appears after `apply` must not
    // leave a permanent `ERR_HOST_NO_*`. The fixed-cost probe starts here
    // (startup time) and is awaited only by `status` — it is deliberately not
    // on any request path.
    const hostFacts: BoostHostFacts = {
      get hasTokenMeter() {
        return meter.kind() === 'host'
      },
      get hasSpill() {
        // `refresh`, not the memo: a status call reports the host *now*, so a
        // provider that was replaced or disposed since the last write must not
        // keep `hasSpill` true (review rows 6 and 50).
        return spillService.refresh() !== undefined
      },
      get spillUsable() {
        // Presence is not capability: `{}` resolves, so `hasSpill` alone would
        // report a healthy projection path until the first `saveText` fails
        // (review row 50). Probe the method shape, never call it — a status
        // read must not write a spill artifact. A broken binding is dropped so
        // a replaced provider is picked up by the next status.
        try {
          const backend = spillService.refresh()
          if (backend === undefined) return false
          if (typeof backend.saveText === 'function') return true
          spillService.reset()
          return false
        } catch {
          spillService.reset()
          return false
        }
      },
      get hasWorkspaceRegistry() {
        // Live fact: a registry that appeared, disappeared or was replaced
        // since `apply` must be reported as it is now.
        return registry.refresh() !== undefined
      },
      get workspaceRegistryBroken() {
        // `resolve.ts` swallows a throwing `list()` per call by design: one
        // invisible session must not crash a hook. That swallow is exactly why
        // the failure needs a status-time probe, or every session is judged
        // invisible while `degraded` stays empty (review row 6). A non-array is
        // the same fail-closed answer in the resolver, so it is the same
        // degradation here. `refresh` re-reads the binding so a repaired
        // provider clears the code on the very next status.
        try {
          const backend = registry.refresh()
          if (backend === undefined) return false
          if (Array.isArray(backend.list())) return false
          registry.reset()
          return true
        } catch {
          registry.reset()
          return true
        }
      },
    }
    const fixedOverhead = measureBoostFixedOverhead()

    // The hook reads this synchronously, so it only ever returns the warmed
    // answer. The map alone is not the answer: a workspace disabled between
    // commit and synthesis leaves the id behind but flips `judgement` to false.
    const resolveSession = (sessionId: string): string | undefined => {
      try {
        if (!scope.judgement(sessionId)) return undefined
        return workspaces.get(sessionId)
      } catch {
        return undefined
      }
    }

    // `deps` MUST stay the same object `registerHooks` receives: it publishes
    // the created `ReceiptSessionState` onto `deps.sessionState`, and
    // `clearSession(deps, id)` can only reach it through that reference.
    const deps: HookDeps = {
      config: cfg,
      scope,
      receipts,
      anchors,
      resolveSession,
      queue,
      plans,
      sessions,
      // Getters, not snapshots: the hook reads them per decision, so a service
      // that becomes active after `apply` is picked up on the next call.
      get spill() {
        return spillBackend()
      },
      retrievals,
      get estimateText() {
        return meter.estimate()
      },
      get estimateKind() {
        return meter.kind()
      },
      projectionCounters,
      // The live horizon, so a projection receipt pins the value its own
      // decision was made under instead of whatever the cross-session minimum
      // happens to be when an operator runs `boost status` (design §5.3).
      horizonFor: (sessionId) => horizon.remainingFor(sessionId),
      // The dispatch mirror lives in the post-execute module and `clearSession`
      // lives in the stream module; this is the seam that lets a disposal drop
      // the mirror instead of leaking one entry per disposed session.
      clearAcceptedDispatch: (sessionId) => clearAcceptedDispatch(deps, sessionId),
      get llm() {
        return llmBackend()
      },
      selectorRoute: (sessionId) => routes.get(sessionId),
    }
    // The section mount is the first thing `registerHooks` touches. Only the
    // host's genuine duplicate error means a previous apply already owns the
    // mounts; every other throw is a wiring failure that must be named, must
    // not take the other three mounts (or the control tool) down with it, and
    // must be visible in `status` as `ERR_BOOST_PARTIAL_MOUNT` (review row 2).
    const missingMounts = new Set<string>()
    const mounts = mountHooks(ctx, deps, missingMounts)
    if (mounts.alreadyMounted) return

    // The clock/visibility warm and the session-end cleanup. Wired separately
    // so a host that cannot accept these events still gets the tool below.
    // `wireSessionEvents` mounts each listener in its own try/catch: a throw at
    // the first one cannot drop the other six (in particular
    // `session/disposed`, whose loss leaks per-session state for the process
    // lifetime), and every failure is named in `missingMounts`.
    try {
      wireSessionEvents(
        ctx,
        deps,
        scope,
        registryBackend,
        sessions,
        horizon,
        workspaces,
        routes,
        projectionCounters,
        missingMounts,
        mounts.ownsSection,
      )
    } catch (error) {
      // Only an assembly bug reaches here; each listener mount is contained.
      missingMounts.add('session-events')
      ctx.logger?.warn?.(
        `dsh-boost: ERR_BOOST_PARTIAL_MOUNT: session wiring failed (${messageOf(error)})`,
      )
    }

    // After the hooks: a genuine duplicate aborts above before it can register
    // the tool twice. A different section failure still reaches here, and so
    // does a tool registration failure of its own — neither may be swallowed
    // behind the other's diagnosis.
    try {
      registerBoostTool(ctx, {
        scope,
        receipts,
        host: hostFacts,
        fixedOverhead: () => fixedOverhead,
        get estimateKind() {
          return meter.kind()
        },
        // Design §5.3's runtime horizon: min(config horizon, mean of the last
        // `historyTurns` completed turns) over live sessions. `runBoost` spreads
        // the deps when it is called, so this getter is read at status time.
        get horizonSteps() {
          return horizon.remaining()
        },
        locatorEvictions: () => retrievals.evictions(),
        receiptReadErrors: () => receipts.readErrors(),
        receiptsTruncated: () => receipts.scanTruncated(),
        unknownFamilies: () => projectionCounters.unknownFamilies(),
        unknownTools: () => projectionCounters.unknownToolCounts(),
        protocolSuppressed: () => projectionCounters.protocolSuppressions(),
        completeSectionSuppressions: () => projectionCounters.protocolMissings(),
        partialMounts: () => [...missingMounts],
      })
    } catch (error) {
      // The tool is the user's only control surface; its failure is reported
      // on its own, never as a hook failure.
      ctx.logger?.warn?.(
        `dsh-boost: boost tool registration failed (ERR_BOOST_TOOL_REGISTER_FAILED): ${messageOf(error)}`,
      )
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-boost: hook registration skipped: ${messageOf(error)}`)
  }
}
