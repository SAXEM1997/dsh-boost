/**
 * Shared types for dsh-boost.
 *
 * `PluginContext` is the minimal projection of the host services this plugin
 * uses (`tools` and `systemPrompt` are required; `llm` is a soft service the
 * selector resolves lazily); it is deliberately narrower than the full cordis
 * `Context` so the behaviour modules can be tested against a fake host.
 * `BoostConfig` mirrors the config surface published in `cordis.patch.yml`
 * (design §5.3).
 *
 * Every shape here is structural. This module is reachable from the published
 * `dist/index.d.ts`, and the package deliberately declares no host
 * dependencies, so importing a host type here would make a consumer's
 * `skipLibCheck: false` typecheck fail without the host tree. The one host
 * augmentation the selector needs lives in `host-augment.d.ts`, which `tsc`
 * consumes but never emits.
 *
 * @module dsh-boost/types
 */

/** Minimal projection of the host `Agent`: only session identity and cwd are read. */
export interface AgentLike {
  session: { header: { id: string; cwd?: string } }
}

/**
 * The parts of the host's `AbortSignal` this package's declarations name.
 *
 * The plugin never constructs a signal and never calls a method on one: it
 * forwards the host's object through `ToolActivationContext` and reads
 * `aborted` at the post-execute seam. Naming the DOM global directly made the
 * published `dist/types.d.ts` unusable for a consumer compiled with
 * `lib: ["ES2023"]` and `types: []` (`TS2304: Cannot find name 'AbortSignal'`),
 * even though that consumer would never call the missing lib. A structural
 * shape keeps the declaration self-contained and still accepts a real
 * `AbortSignal` (it has `aborted` and both listener methods).
 */
export interface AbortSignalLike {
  readonly aborted: boolean
  addEventListener(type: string, listener: (...args: any[]) => void, options?: unknown): void
  removeEventListener(type: string, listener: (...args: any[]) => void, options?: unknown): void
}

/**
 * The host's activation context for a step-time tool condition.
 *
 * Mirrors `dsh-tools`' `ToolActivationContext`; the plugin only passes it
 * through, so the shape stays structural.
 */
export interface ToolActivationContext {
  readonly agent: AgentLike
  readonly modelSelection: Readonly<Record<string, unknown>>
  readonly signal: AbortSignalLike
}

/** The host's step-admitted tool set (`dsh-tools`' `ResolvedToolSet`). */
export interface ResolvedToolSet {
  dispose(): void
  view(scope: unknown): ReadonlyMap<string, unknown>
}

/** A model request as the selector builds it (structural; no host import). */
export interface GenerateOptions {
  readonly [key: string]: unknown
}

/** One streamed chunk as the selector consumes it (structural). */
export interface StreamChunk {
  readonly [key: string]: unknown
}

/** Host services and helpers used by the plugin. */
export interface PluginContext {
  logger: {
    info(msg: string): void
    warn(msg: string): void
  }
  /**
   * Register a waterfall listener.
   *
   * `prepend` is cordis's ordering option: a prepended listener is unshifted,
   * and cordis runs the first-registered listener outermost.
   */
  on(
    event: string,
    handler: (...args: any[]) => unknown,
    options?: { prepend?: boolean },
  ): void
  tools: {
    register(
      def: unknown,
      opts?: { when?: (c: ToolActivationContext) => boolean | Promise<boolean> },
    ): void
    resolve(context: ToolActivationContext): Promise<ResolvedToolSet>
  }
  /**
   * The host LLM service. Soft: projection and admission never touch it, and
   * the selector fails closed with `selector-unavailable` when it is absent.
   */
  llm?: {
    stream(opts: GenerateOptions): AsyncIterable<StreamChunk>
  }
  systemPrompt: {
    section(s: {
      name: string
      order: number
      text: string | ((c: { scope?: unknown }) => string)
      interpolate?: boolean
    }): void
  }
  get<T = unknown>(name: string): T | undefined
}

/** Tool families that have projection parameters; every other tool is passed through. */
export type ToolFamily = 'read' | 'grep' | 'glob' | 'bash' | 'ssh'

/** Per-family receipt projection window, in characters (design §5.3). */
export interface ProjectionParams {
  triggerChars: number
  headChars: number
  tailChars: number
}

/** A provider/model pair, used only as the distillation override (ticket #10). */
export interface DistillRoute {
  provider: string
  model: string
}

/**
 * Receipt distillation: answer one fixed question about a long receipt with a
 * fast model, keep the answer only if it is verifiable and strictly shorter
 * than the truncation view it replaces (ADR 0001, ticket #10).
 *
 * `enabled: false` (the default) makes the whole path unreachable, and the
 * projection behaves exactly as it did before distillation existed.
 */
export interface DistillConfig {
  /** Master switch; off by default. */
  enabled: boolean
  /** The families that may be distilled. `read`/`grep`/`glob` are structural and stay truncated. */
  families: ToolFamily[]
  /** The pre-gate length in code points; `null` means the family's `projection.triggerChars`. */
  triggerChars: number | null
  /** Output cap for one distillation call, clamped to 1..4096. */
  maxOutputTokens: number
  /** Wall-clock bound for one call, clamped to 100..30000; a timeout falls back to truncation. */
  timeoutMs: number
  /** `null` reuses the boundary route the selector inherits; set to pin a cheaper model. */
  route: DistillRoute | null
}

/** Plugin configuration surface; every key falls back to its design default when absent. */
export interface BoostConfig {
  projection: Record<ToolFamily, ProjectionParams>
  admission: { thresholdTokens: number }
  selector: { maxTokens: number }
  distillation: DistillConfig
  stepsPerTurn: number
  horizonSteps: number
  historyTurns: number
}
