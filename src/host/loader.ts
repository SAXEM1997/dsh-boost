/**
 * The optional-peer import seam.
 *
 * A static `import` of an optional host package is `ERR_MODULE_NOT_FOUND` at
 * module-evaluation time, which kills the whole plugin before any degradation
 * path can run (design §5.4/§9). Every optional peer — the spill policy and the
 * token meter — must therefore load through this function, which turns a
 * missing package (or one that throws while evaluating) into `undefined`.
 *
 * The function is deliberately total: a broken peer is the same as an absent
 * one for the plugin's purposes, and a host that installed it badly must still
 * get the plugin's degraded mode rather than a failed load.
 *
 * @module dsh-boost/host/loader
 */

/**
 * Import `specifier`, or return `undefined` when it cannot be loaded.
 *
 * `T` is the module namespace the caller expects; it is not validated here —
 * callers check the individual export they use, because a package can exist
 * while an export is missing in another version.
 */
export async function loadOptional<T>(specifier: string): Promise<T | undefined> {
  try {
    return (await import(specifier)) as T
  } catch {
    return undefined
  }
}
