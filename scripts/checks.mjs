/**
 * The canonical list of check instances `verify-package.mjs` runs.
 *
 * One list, two consumers: the gate asserts it ran exactly these, and
 * `gate-negatives.mjs` asserts it has a negative case for each. Without a
 * shared list a thirteenth check could be added and the negative-case gate
 * would still report "12/12" — a gate claiming coverage it does not have.
 *
 * The label is `<name>` when the check runs once, and `<name> (<install mode>)`
 * for the two that run twice, once per install pass. Those two are genuinely
 * different checks: `install` with `--ignore-scripts` catches a platform
 * refusal, `install` with scripts enabled catches a broken `postinstall`.
 */
export const CHECK_NAMES = [
  'dist-index-present',
  'tarball-allowlist',
  'declarations-host-free',
  'client-bundle-structure',
  'exports-targets (ignore-scripts)',
  'bundle-patch (ignore-scripts)',
  'install (ignore-scripts)',
  'typecheck (ignore-scripts)',
  'typecheck-no-host-stubs (ignore-scripts)',
  'import-require-locales (ignore-scripts)',
  'install (default)',
  'import-require-locales (default)',
]
