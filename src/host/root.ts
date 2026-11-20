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
import { join, resolve } from 'node:path'

/**
 * `<DSH_HOME>/boost`, falling back to `<homedir>/.dsh/boost`.
 *
 * A `config.dshHome` override wins over the environment, matching the other
 * host plugins (`dsh-mcp-btwy` resolves `config.dshHome` before `$DSH_HOME`):
 * an operator who patches the plugin row should not have to change the
 * process environment for all plugins. A non-string or blank override is
 * ignored and the environment rule applies.
 *
 * A blank value is treated as unset: `join('', 'boost')` would otherwise put
 * state in the process's working directory, which is not a home directory.
 *
 * A relative home is resolved against the current cwd **once**, here.
 * Passing it through would leave the stores resolving it again on every read,
 * so a later `chdir` would silently move the state root mid-session (review
 * minor).
 */
export function resolveBoostRoot(config?: unknown): string {
  const override = (config as { dshHome?: unknown } | null | undefined)?.dshHome
  const configured =
    typeof override === 'string' && override.trim() !== ''
      ? override.trim()
      : process.env.DSH_HOME?.trim()
  const home = configured ? resolve(configured) : join(homedir(), '.dsh')
  return join(home, 'boost')
}
