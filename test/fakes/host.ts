/**
 * Minimal fake host for the dsh-boost test suite.
 *
 * The host is a single object literal, not a class hierarchy: `fakeHost()`
 * builds every member later tasks depend on, and `overrides` is shallow-merged
 * last so a test can replace exactly one member (for example
 * `fakeHost({ receipts: myReceipts })` or a canned `llm`).
 *
 * Behaviour that no test exercises yet is the smallest honest implementation:
 * `nextCalls` and `synthesized` are counters left at 0, `receipts` is an empty
 * array, and `llm.stream` yields an empty stream. `tokenMeter` is empty because
 * no estimator is installed; a test that needs one overrides it.
 *
 * The hook surface is real: `on(name, handler)` records waterfall handlers,
 * `hooked()` lists the mounted names, and `callHook(name, args, next)` runs
 * them in registration order, passing each the previous `next`. Prompt
 * sections are recorded too, and `hooked()` reports `'systemPrompt'` once one
 * is registered, so a test can assert every mount point with one call.
 *
 * @module dsh-boost/test/fakes/host
 */
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AgentLike } from '../../src/types.js'

/** One `ctx.tools.register` call: the definition plus its optional `when`. */
type Registered = {
  def: any
  when?: (c: { agent: AgentLike; signal: AbortSignal }) => boolean | Promise<boolean>
}

/** One `ctx.systemPrompt.section` registration. */
type Section = {
  name: string
  order: number
  text: string | ((c: any) => string)
  interpolate?: boolean
}

/** A stream that yields nothing; tests replace `llm` when they need chunks. */
async function* emptyStream(): AsyncGenerator<StreamChunk> {
  // Intentionally empty: no test at this layer needs real model output.
}

/** Build a fake host; `overrides` replace members shallowly. */
export function fakeHost(overrides: Record<string, unknown> = {}): any {
  const registrations: Registered[] = []
  const hooks = new Map<string, ((...args: any[]) => unknown)[]>()
  const sections = new Map<string, Section>()
  let last: AsyncIterable<StreamChunk> | undefined

  const host: any = {
    // --- tool registry: record the definition and its `when` predicate ---
    register(def: unknown, opts?: { when?: Registered['when'] }): void {
      registrations.push({ def, when: opts?.when })
    },
    resolve(): readonly unknown[] {
      return registrations.map(registration => registration.def)
    },
    definitions: registrations,

    // --- host services ---
    llm: {
      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        const iterable = emptyStream()
        last = iterable
        return iterable
      },
    },
    systemPrompt: {
      section(section: Section): void {
        sections.set(section.name, section)
      },
    },
    tokenMeter: {},
    spillStore: {
      async saveText(input: {
        suggestedName: string
        content: string
      }): Promise<{ locator: string; bytes: number; retrievalHint: string }> {
        return {
          locator: `/spill/${input.suggestedName}`,
          bytes: Buffer.byteLength(input.content, 'utf8'),
          retrievalHint: 'Read the full result with the read tool using offset/limit.',
        }
      },
    },

    // --- hook surface ---
    on(name: string, handler: (...args: any[]) => unknown): void {
      const list = hooks.get(name) ?? []
      list.push(handler)
      hooks.set(name, list)
    },
    async callHook(
      name: string,
      args: readonly unknown[],
      next: (...nextArgs: unknown[]) => unknown,
    ): Promise<unknown> {
      const handlers = hooks.get(name) ?? []
      const run = async (index: number, current: readonly unknown[]): Promise<unknown> => {
        const handler = handlers[index]
        if (handler === undefined) return next(...current)
        return handler(...current, (...nextArgs: unknown[]) => run(index + 1, nextArgs))
      }
      return run(0, args)
    },
    hooked(): string[] {
      const names = [...hooks.keys()]
      if (sections.size > 0) names.push('systemPrompt')
      return names
    },
    section(name?: string): Section | undefined {
      return name === undefined ? [...sections.values()].at(-1) : sections.get(name)
    },

    // --- counters and receipts later tasks fill in ---
    receipts: [],
    nextCalls: 0,
    synthesized: 0,

    // --- stream helpers ---
    stream(sessionId: string, options: Partial<GenerateOptions> = {}): AsyncIterable<StreamChunk> {
      return host.llm.stream({ ...options, sessionId } as GenerateOptions)
    },
    lastStream(): AsyncIterable<StreamChunk> | undefined {
      return last
    },

    // --- visibility probe over the registered definitions ---
    async visible(name: string, agent: AgentLike): Promise<boolean> {
      const registration = registrations.find(
        entry => (entry.def as { name?: unknown } | null)?.name === name,
      )
      if (registration === undefined) return false
      if (registration.when === undefined) return true
      return Boolean(await registration.when({ agent, signal: new AbortController().signal }))
    },
  }

  return Object.assign(host, overrides)
}
