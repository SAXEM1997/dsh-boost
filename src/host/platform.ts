/**
 * Platform capability: is the host a POSIX system?
 *
 * Substitution depends on POSIX process semantics (the dispatched call is
 * synthesised and replayed through the host's tool pipeline), so on Windows it
 * is refused. Projection does not depend on the platform and stays on. The
 * refusal is not silent: `dsh-boost`'s `boost status` reports
 * `ERR_HOST_PLATFORM_UNSUPPORTED` (design §9).
 *
 * The predicate reads `process.platform` at call time rather than caching it at
 * module load, which is what makes the platform a seam a test can control
 * (`Object.defineProperty(process, 'platform', …)`): a load-time constant would
 * freeze the value before the test could change it.
 *
 * @module dsh-boost/host/platform
 */

/** Whether substitution may run on this host. Only `win32` is excluded. */
export const isPosixOnly = (): boolean => process.platform !== 'win32'
