/**
 * The plugin's one data-root rule.
 *
 * All three state files live under it (design §10): `scope.json`, `scope.lock`
 * and `receipts/<encoded-session>.jsonl`. `$DSH_HOME` is the host variable;
 * there is no `ctx` accessor for it (`ctx.get('dshHomePath')` does not exist —
 * an earlier task deleted that dead branch). When it is unset or blank the
 * fallback is `~/.dsh`, and the plugin appends `/boost` in both cases.
 *
 * The receipts store and the scope store receive this root; they never resolve
 * the environment themselves, so a test can point every store at one temporary
 * directory by setting `$DSH_HOME` before `apply`.
 *
 * @module dsh-boost/host/root
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * `<DSH_HOME>/boost`, falling back to `<homedir>/.dsh/boost`.
 *
 * A blank value is treated as unset: `join('', 'boost')` would otherwise put
 * state in the process's working directory, which is not a home directory.
 */
export function resolveBoostRoot(): string {
  const configured = process.env.DSH_HOME?.trim()
  return join(configured ? configured : join(homedir(), '.dsh'), 'boost')
}
