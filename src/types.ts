/**
 * Shared types for dsh-boost.
 *
 * `PluginContext` is the minimal projection of the host services this plugin
 * injects (`tools`, `llm`, `systemPrompt`); it is deliberately narrower than
 * the full cordis `Context` so the behaviour modules can be tested against a
 * fake host. `BoostConfig` mirrors the config surface published in
 * `cordis.patch.yml` (design §5.3).
 *
 * @module dsh-boost/types
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Minimal projection of the host `Agent`: only session identity and cwd are read. */
export interface AgentLike {
  session: { header: { id: string; cwd: string } }
}

/** Host services and helpers required by the plugin's `inject` list. */
export interface PluginContext {
  logger: {
    info(msg: string): void
    warn(msg: string): void
  }
  on(event: string, handler: (...args: any[]) => unknown): void
  tools: {
    register(
      def: unknown,
      opts?: { when?: (c: { agent: AgentLike; signal: AbortSignal }) => boolean | Promise<boolean> },
    ): void
    resolve(): readonly unknown[]
  }
  llm: {
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

/** Plugin configuration surface; every key falls back to its design default when absent. */
export interface BoostConfig {
  projection: Record<ToolFamily, ProjectionParams>
  admission: { thresholdTokens: number }
  selector: { maxTokens: number }
  stepsPerTurn: number
  horizonSteps: number
  historyTurns: number
}

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'boost-selector': true
  }
}
