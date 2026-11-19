/**
 * The `boost` control tool: the user's only way to see or change what the
 * plugin is doing.
 *
 * The plugin itself is invisible — it rewrites what the model sees and never
 * speaks — so this tool's output is part of the product, not a debugging aid.
 * `status` reports what the plugin has actually recorded: the scope document's
 * exposure surface, both switches (`shadow` and `projection`; "recording but
 * not replacing" is not "replacing"), per-code receipt counts over **every**
 * shard, the substitution and projection ledgers, and the stable degraded
 * codes observed. `scope-get` reads `scope.json`; `scope-set` and `shadow`
 * write it; both writes are compare-and-swap through `ScopeStore.write`, so a
 * stale caller gets `ERR_SCOPE_REVISION_CONFLICT` rather than silently
 * overwriting a concurrent change.
 *
 * ## Contracts this module keeps
 *
 * - Every failure is a stable code in a returned value; nothing throws out of
 *   `runBoost`. The store's own codes are passed through unchanged.
 * - `scope-set` never lets a caller set `version` or `revision`: `revision` is
 *   the store's, `version` is fixed at 2, and a body carrying either reserved
 *   field is rejected **before** the mutation runs. The store persists whatever
 *   `mutate` returns, so this rejection is what stops a v1-shaped document.
 * - Both ledger sides come from the receipts. This module never estimates a
 *   retrieval cost; if no producer has recorded one, the net equals the gross
 *   and `retrievals` shows how many retrieved receipts were counted. The
 *   projection saving is read from `saved_projection_tokens` (the design §5.3
 *   name T23b/T26 write), falling back to `saved`; a producer must write one of
 *   them or the headline saving reads as zero. The substitution saving is read
 *   only from the settled line, because the synth-time line predates any
 *   measurement.
 * - `status.degraded` maps the receipt code a real producer writes
 *   (`projection-skipped:no-spill`) to its stable code (`ERR_HOST_NO_SPILL`).
 *   `ERR_HOST_NO_TOKENMETER` has no receipt channel and is left to Task 25's
 *   host probe rather than faked from the receipt stream.
 * - `runBoost` is pure orchestration over the two stores: no `ctx`, no host
 *   calls. The tool definition is therefore testable without a host, and the
 *   host probe lives in `src/index.ts`.
 *
 * The command table is deliberately a plain record, one handler per
 * subcommand, so an unknown `cmd` is a lookup miss rather than a fallthrough.
 *
 * @module dsh-boost/tools/boost
 */
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { ProjectionMode } from '../projection/apply.js'
import {
  ERR_SCOPE_FUTURE_VERSION,
  ERR_SCOPE_LOCKED,
  ERR_SCOPE_PARSE_FAILED,
  ERR_SCOPE_READ_FAILED,
  ERR_SCOPE_REVISION_CONFLICT,
  ERR_SCOPE_UNKNOWN_VERSION,
} from '../scope/doc.js'
import type { ScopeCode, ScopeDoc } from '../scope/doc.js'
import type { ScopeStore } from '../scope/store.js'
import type { ReceiptStore } from '../receipts/store.js'

/** Stable failure code: `cmd` names no subcommand this tool implements. */
const ERR_BOOST_UNKNOWN_CMD = 'ERR_BOOST_UNKNOWN_CMD'

/** Stable failure code: a required argument (`baseRevision`) is missing or malformed. */
const ERR_BOOST_INVALID_ARGS = 'ERR_BOOST_INVALID_ARGS'

/** Stable failure code: `body` is not a valid, writable scope patch. */
const ERR_BOOST_INVALID_BODY = 'ERR_BOOST_INVALID_BODY'

/** Stable failure code: an unexpected internal failure, so the tool still answers. */
const ERR_BOOST_INTERNAL = 'ERR_BOOST_INTERNAL'

/** Every scope failure code, for passing the store's codes through unchanged. */
const SCOPE_CODES: ReadonlySet<string> = new Set([
  ERR_SCOPE_UNKNOWN_VERSION,
  ERR_SCOPE_FUTURE_VERSION,
  ERR_SCOPE_PARSE_FAILED,
  ERR_SCOPE_READ_FAILED,
  ERR_SCOPE_REVISION_CONFLICT,
  ERR_SCOPE_LOCKED,
])

/**
 * Receipt codes that mean the host is degraded, mapped to the stable code
 * `status` reports.
 *
 * `projection-skipped:no-spill` is the code the projection path records when
 * the spill backend is absent (design §5.4), so it is the real producer behind
 * `ERR_HOST_NO_SPILL`. `ERR_HOST_NO_TOKENMETER` has no receipt channel at all:
 * it is a host probe result and is added by Task 25, not invented here.
 */
const RECEIPT_DEGRADATION: ReadonlyArray<{ readonly code: string; readonly degraded: string }> = [
  { code: 'projection-skipped:no-spill', degraded: 'ERR_HOST_NO_SPILL' },
]

/** The scope document's caller-writable fields. Everything else is store-owned. */
const PATCH_FIELDS = ['mode', 'workspaceIds', 'shadow', 'projection'] as const

/** Fields a caller must never set: the store owns one, the format fixes the other. */
const RESERVED_FIELDS = ['version', 'revision'] as const

/** The four subcommands. */
type BoostCmd = 'status' | 'scope-get' | 'scope-set' | 'shadow'

/** Raw tool arguments, after the model (or a test) produced them. */
type BoostArgs = { cmd: BoostCmd; body?: unknown; baseRevision?: number }

/** Successful report or a stable failure code — never a thrown error. */
type BoostResult = { ok: true; data: unknown } | { ok: false; code: string }

/** The two stores `runBoost` orchestrates. */
type BoostDeps = { scope: ScopeStore; receipts: ReceiptStore }

/** What `status` reports. Both switches are top-level on purpose: they differ. */
export interface BoostStatus {
  scope: { mode: ScopeDoc['mode']; workspaceIds: string[]; revision: number }
  shadow: boolean
  projection: ProjectionMode
  saved: {
    /**
     * Σ numeric `saved_input_tokens` over settled substitutions only. The
     * synth-time `substitute` line predates any measurement (design §5.3 says
     * the field is measured), so its value is `'unknown'` or absent and never
     * contributes; `counts` keeps the event count.
     */
    substitution: number
    /**
     * Σ `saved_projection_tokens` (T23b/T26's authoritative name, with `saved`
     * as the legacy fallback) over `kind:'projection'` receipts carrying
     * `unit:'raw'`.
     */
    projectionGross: number
    /** `projectionGross` minus the recorded `retrievalCost` of retrieved receipts. */
    projectionNet: number
    /** Number of `kind:'projection'` receipts marked `retrieved: true`. */
    retrievals: number
  }
  /** Receipt count per `code`, over every shard (including the empty session id). */
  counts: Record<string, number>
  /** Stable degradation codes actually observed. */
  degraded: string[]
}

/** A validated scope patch: only the caller-writable fields survive. */
type ScopePatch = Partial<Pick<ScopeDoc, (typeof PATCH_FIELDS)[number]>>

/**
 * The receipt aggregation behind `status`, kept separate from the document
 * read so the accounting has one home and one test surface.
 *
 * `scan()` is called with no session id on purpose: `skip:no-scope` receipts
 * live under the empty session id, so a per-session scan would miss them.
 */
async function aggregate(receipts: ReceiptStore): Promise<{
  counts: Record<string, number>
  saved: BoostStatus['saved']
  degraded: string[]
}> {
  const counts: Record<string, number> = Object.create(null)
  let substitution = 0
  let projectionGross = 0
  let retrievals = 0
  let retrievalCost = 0

  for await (const receipt of receipts.scan()) {
    // A receipt is untrusted text from a file: `counts` has no prototype so a
    // code of `toString` or `__proto__` is an ordinary numeric key, never a
    // string concatenation and never a dropped assignment.
    if (typeof receipt.code === 'string') {
      counts[receipt.code] = (counts[receipt.code] ?? 0) + 1
    }

    // Only the settled line carries a measured saving; the synth-time line is
    // an event and is already visible in `counts`.
    if (receipt.kind === 'substitute-settled') {
      const saved = receipt.saved_input_tokens
      if (typeof saved === 'number' && Number.isFinite(saved)) substitution += saved
    }

    if (receipt.kind !== 'projection') continue
    if (receipt.unit === 'raw') {
      // T23b/T26 write `saved_projection_tokens`; `saved` is the pre-T23b
      // spelling this consumer accepted first. Never estimate a value here.
      const saved = receipt.saved_projection_tokens ?? receipt.saved
      if (typeof saved === 'number' && Number.isFinite(saved)) projectionGross += saved
    }
    if (receipt.retrieved === true) {
      retrievals += 1
      const cost = receipt.retrievalCost
      if (typeof cost === 'number' && Number.isFinite(cost)) retrievalCost += cost
    }
  }

  const degraded = RECEIPT_DEGRADATION.filter(entry => counts[entry.code] !== undefined).map(
    entry => entry.degraded,
  )
  return {
    counts,
    saved: {
      substitution,
      projectionGross,
      projectionNet: projectionGross - retrievalCost,
      retrievals,
    },
    degraded,
  }
}

/** `status`: the scope document plus the receipt ledgers, never a failure. */
async function statusCommand(deps: BoostDeps): Promise<BoostResult> {
  const read = await deps.scope.read()
  const totals = await aggregate(deps.receipts)
  const degraded =
    read.degraded === undefined ? totals.degraded : [...totals.degraded, 'scope-degraded']
  const data: BoostStatus = {
    scope: {
      mode: read.doc.mode,
      workspaceIds: read.doc.workspaceIds,
      revision: read.doc.revision,
    },
    shadow: read.doc.shadow,
    projection: read.doc.projection,
    saved: totals.saved,
    counts: totals.counts,
    degraded,
  }
  return { ok: true, data }
}

/** `scope-get`: a faithful read; a degraded read is a stable tool failure. */
async function scopeGetCommand(deps: BoostDeps): Promise<BoostResult> {
  const read = await deps.scope.read()
  if (read.degraded !== undefined) return { ok: false, code: read.code ?? ERR_SCOPE_READ_FAILED }
  return { ok: true, data: read.doc }
}

/** Whether a value can be a caller-supplied base revision. */
function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Whether `value` is one of the three projection modes. */
function isProjectionMode(value: unknown): value is ProjectionMode {
  return value === 'off' || value === 'shadow' || value === 'on'
}

/**
 * Validate a `scope-set` body and prune it to the writable fields.
 *
 * Reserved fields are checked **first**: the store persists whatever `mutate`
 * returns, so a body carrying `version` or `revision` must be refused before a
 * patch is built, not stripped and written as if the caller's intent were
 * merely advisory. Unknown keys are pruned; a known key with a wrong type is
 * rejected, never coerced.
 */
function scopePatchOf(body: unknown): { ok: true; patch: ScopePatch } | { ok: false; code: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: ERR_BOOST_INVALID_BODY }
  }
  const source = body as Record<string, unknown>
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(source, key)
  if (RESERVED_FIELDS.some(has)) return { ok: false, code: ERR_BOOST_INVALID_BODY }

  const patch: ScopePatch = {}
  if (has('mode')) {
    if (source.mode !== 'selected' && source.mode !== 'global') {
      return { ok: false, code: ERR_BOOST_INVALID_BODY }
    }
    patch.mode = source.mode
  }
  if (has('workspaceIds')) {
    const ids = source.workspaceIds
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
      return { ok: false, code: ERR_BOOST_INVALID_BODY }
    }
    patch.workspaceIds = [...ids]
  }
  if (has('shadow')) {
    if (typeof source.shadow !== 'boolean') return { ok: false, code: ERR_BOOST_INVALID_BODY }
    patch.shadow = source.shadow
  }
  if (has('projection')) {
    if (!isProjectionMode(source.projection)) return { ok: false, code: ERR_BOOST_INVALID_BODY }
    patch.projection = source.projection
  }
  return { ok: true, patch }
}

/** The store's stable code, or undefined for anything else (which never escapes). */
function scopeCodeOf(error: unknown): ScopeCode | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && SCOPE_CODES.has(code) ? (code as ScopeCode) : undefined
}

/**
 * One compare-and-swap write shared by `scope-set` and `shadow`.
 *
 * `version: 2` is forced even though `ScopeStore.write` bases a corrupt or
 * v1 file on `DEFAULT_SCOPE`: the invariant must hold at the mutation boundary,
 * where the store's "persist whatever `mutate` returns" contract makes it
 * binding. `revision` is deliberately absent — the store owns it.
 */
async function writeScope(
  scope: ScopeStore,
  mutate: (doc: ScopeDoc) => ScopeDoc,
  baseRevision: number,
): Promise<BoostResult> {
  try {
    const doc = await scope.write(mutate, baseRevision)
    return { ok: true, data: doc }
  } catch (error) {
    const code = scopeCodeOf(error)
    if (code !== undefined) return { ok: false, code }
    throw error
  }
}

/** `scope-set`: validate, prune, then write with compare-and-swap. */
async function scopeSetCommand(deps: BoostDeps, args: BoostArgs): Promise<BoostResult> {
  const parsed = scopePatchOf(args.body)
  if (!parsed.ok) return parsed
  if (!isRevision(args.baseRevision)) return { ok: false, code: ERR_BOOST_INVALID_ARGS }
  const patch = parsed.patch
  return writeScope(
    deps.scope,
    doc => ({ ...doc, ...patch, version: 2 }),
    args.baseRevision,
  )
}

/** `shadow`: the shadow-week switch, independent of `projection`. */
async function shadowCommand(deps: BoostDeps, args: BoostArgs): Promise<BoostResult> {
  if (typeof args.body !== 'boolean') return { ok: false, code: ERR_BOOST_INVALID_BODY }
  if (!isRevision(args.baseRevision)) return { ok: false, code: ERR_BOOST_INVALID_ARGS }
  const shadow = args.body
  return writeScope(deps.scope, doc => ({ ...doc, shadow }), args.baseRevision)
}

/** One handler per subcommand; the table is the dispatch and the documentation. */
const COMMANDS: Record<BoostCmd, (deps: BoostDeps, args: BoostArgs) => Promise<BoostResult>> = {
  status: statusCommand,
  'scope-get': scopeGetCommand,
  'scope-set': scopeSetCommand,
  shadow: shadowCommand,
}

/**
 * Run one `boost` invocation. Pure orchestration over the two stores.
 *
 * Failures are values: an unknown command, an invalid body or a store code all
 * come back as `{ ok: false, code }`. The `try` covers the argument read as
 * well as the handler, so a null call or an argument object with a throwing
 * getter answers a stable code instead of throwing. The catch exists only so
 * an unexpected store failure cannot turn the user's only control surface into
 * a thrown tool error; it is not an expected path.
 */
export async function runBoost(input: {
  args: { cmd: BoostCmd; body?: unknown; baseRevision?: number }
  scope: ScopeStore
  receipts: ReceiptStore
}): Promise<{ ok: true; data: unknown } | { ok: false; code: string }> {
  try {
    const args = (input as { args?: unknown } | null | undefined)?.args
    const cmd = (args as { cmd?: unknown } | null | undefined)?.cmd
    const handler =
      typeof cmd === 'string' && Object.prototype.hasOwnProperty.call(COMMANDS, cmd)
        ? COMMANDS[cmd as BoostCmd]
        : undefined
    if (handler === undefined) return { ok: false, code: ERR_BOOST_UNKNOWN_CMD }
    return await handler(input, args as BoostArgs)
  } catch {
    return { ok: false, code: ERR_BOOST_INTERNAL }
  }
}

/** Model-facing description: what each command does and what it returns. */
const DESCRIPTION = [
  'Inspect or change dsh-boost state. Commands:',
  'status reports the scope document, both switches (shadow, projection), receipt counts per code across all sessions, substitution and projection savings, and observed degraded codes;',
  'scope-get reads the full scope document;',
  'scope-set replaces the given scope fields with compare-and-swap; body = { mode?, workspaceIds?, shadow?, projection? }; version and revision are store-owned and rejected;',
  'shadow persists the shadow-week switch; body = boolean.',
  'scope-set and shadow require the baseRevision last seen via status or scope-get; a stale revision fails with ERR_SCOPE_REVISION_CONFLICT. Failures are { ok:false, code } values, never thrown.',
].join(' ')

/** The argument schema shown to the model; `status`/`scope-get` need only `cmd`. */
const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    cmd: {
      type: 'string',
      enum: ['status', 'scope-get', 'scope-set', 'shadow'],
      description: 'Which boost operation to run.',
    },
    body: {
      description:
        'scope-set: the desired scope fields (unknown keys are pruned, version/revision rejected). shadow: the desired boolean.',
      oneOf: [
        {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['selected', 'global'] },
            workspaceIds: { type: 'array', items: { type: 'string' } },
            shadow: { type: 'boolean' },
            projection: { type: 'string', enum: ['off', 'shadow', 'on'] },
          },
        },
        { type: 'boolean' },
      ],
    },
    baseRevision: {
      type: 'integer',
      minimum: 0,
      description: 'Required by scope-set and shadow: the revision last seen.',
    },
  },
  required: ['cmd'],
  additionalProperties: false,
}

/**
 * The canonical output envelope. The host validates every successful return
 * against this schema, and a failure is a successful call whose value is
 * `{ ok: false, code }` (the tool never throws its stable codes), so both
 * branches are declared.
 */
const OUTPUT_SCHEMA: JsonSchemaNode = {
  oneOf: [
    {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        data: {},
      },
      required: ['ok', 'data'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: false },
        code: { type: 'string' },
      },
      required: ['ok', 'code'],
      additionalProperties: false,
    },
  ],
}

/** Render the canonical envelope as one text block; `JSON.stringify` is the format. */
function renderResult(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) ?? 'undefined' }]
}

/**
 * Build the host tool definition.
 *
 * `output: { schema, render }` is mandatory in the host's `ToolDefinition`;
 * a definition missing it is rejected at registration. `execute` reuses
 * `runBoost`, so the tool and the pure orchestration cannot drift.
 */
export function boostTool(deps: BoostDeps): {
  name: 'boost'
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: JsonSchemaNode
    render: (args: unknown, value: unknown) => { type: 'text'; text: string }[]
  }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
} {
  return {
    name: 'boost',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    execute: (args, _exec) => runBoost({ args: args as BoostArgs, ...deps }),
  }
}