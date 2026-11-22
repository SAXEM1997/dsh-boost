/**
 * The wire contract between the route and the page, in one place.
 *
 * Both halves are built separately and neither can import the other's runtime,
 * so the shape they agree on lives here. A field renamed on one side and not
 * the other is a silent `undefined` at runtime — the page renders "未测量" and
 * nobody notices — which is why the types are shared rather than restated.
 *
 * The command results are `runBoost` envelopes, not bare payloads. The two
 * released regressions this file exists to prevent were both a read one level
 * off (`saved` off the envelope, `.ok` off the payload); with the envelope
 * declared as a type, either read is a compile error.
 */
import type { ScopeDoc } from '../scope/doc.js'
import type { BoostConfig } from '../types.js'
import type { BoostStatus } from '../tools/boost.js'

/** A workspace as the route reports it. */
export interface WorkspaceEntry {
  id: string
  path: string
  /**
   * The host's display name for the workspace, when it has one.
   *
   * `@deepseek-ai/dsh-workspace`'s `Workspace` carries `title`; it is optional
   * here because the field is not guaranteed across host versions, and the page
   * falls back to the path.
   */
  title?: string
}

/**
 * The workspace list, or the reason there is none.
 *
 * `available: false` is NOT an empty list: the page disables saving on it and
 * says the list could not be read. Rendering an empty list instead would read
 * as "you have no workspaces", which is a different, wrong statement.
 */
export type WorkspaceListing =
  | { available: true; entries: WorkspaceEntry[] }
  | { available: false; code: string }

/**
 * One command's answer: the payload, or the stable code that stopped it.
 *
 * `runBoost` returns this shape and `/state` forwards it verbatim, so it is
 * declared once and parameterised by the payload. `ok` is the envelope's
 * field: a payload has no `ok`, and an envelope has none of the payload's
 * fields. Asking the wrong one of the two is a compile error, not a silent
 * `undefined` that renders as "nothing is degraded".
 */
export type Envelope<T> = { ok: true; data: T } | { ok: false; code: string }

/** The JSON body `GET /dsh-boost/api/state` returns. */
export interface StatePayload {
  /** `runBoost` with `{ cmd: 'status' }`. */
  status: Envelope<BoostStatus>
  /** `runBoost` with `{ cmd: 'scope-get' }`. */
  scope: Envelope<ScopeDoc>
  workspaces: WorkspaceListing
  /**
   * The effective configuration `resolveConfig` produced at load.
   *
   * The route always resolves it (a malformed overlay degrades to defaults),
   * but it travels in the same envelope as the command results so the page has
   * one shape to read instead of a convention it has to remember per field.
   */
  config: Envelope<BoostConfig>
}
