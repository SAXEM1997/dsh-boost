/**
 * The plugin's auxiliary request purposes, declared on the host's open map.
 *
 * `boost-selector` is the selector; `boost-distill` is receipt distillation
 * (ticket #10). Both are auxiliary calls, so the `llm/stream` hook passes them
 * through without observing or settling them.
 *
 * `GenerateOptions.purpose` is typed as `keyof LlmRequestPurposeMap`, so a
 * producer package adds its key by module augmentation. This file is an
 * ambient INPUT: `tsc` includes it in the program (the augmentation applies
 * project-wide) but emits nothing for a `.d.ts`, which keeps the augmentation
 * out of the published declaration graph. A consumer of `dsh-boost` must not
 * inherit an augmentation of a package it does not depend on.
 *
 * Do not move this into `types.ts` or any other emitted module: `types.ts` is
 * reachable from `dist/index.d.ts`, and the augmentation there would both
 * import a host package the manifest does not declare and silently degrade
 * under `skipLibCheck`.
 */
export {}

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'boost-selector': true
    'boost-distill': true
  }
}
