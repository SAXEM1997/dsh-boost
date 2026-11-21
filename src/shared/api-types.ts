/**
 * The wire contract between the route and the page, in one place.
 *
 * Both halves are built separately and neither can import the other's runtime,
 * so the shape they agree on lives here. A field renamed on one side and not
 * the other is a silent `undefined` at runtime — the page renders "未测量" and
 * nobody notices — which is why the types are shared rather than restated.
 */

/** A workspace as the route reports it. */
export interface WorkspaceEntry {
  id: string
  path: string
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

/** The JSON body `GET /dsh-boost/api/state` returns. */
export interface StatePayload {
  status: unknown
  scope: unknown
  workspaces: WorkspaceListing
  config: unknown
}
