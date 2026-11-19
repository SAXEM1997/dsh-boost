/**
 * Minimal fake host for the dsh-boost test suite.
 *
 * The host is a single object literal, not a class hierarchy: `fakeHost()`
 * builds every member later tasks depend on, and `overrides` is shallow-merged
 * last so a test can replace exactly one member (for example
 * `fakeHost({ receipts: myReceipts })` or a canned `llm`).
 *
 * The hook surface follows the real waterfall contract: `on(name, handler)`
 * records handlers, `hooked()` lists the mounted names, and
 * `callHook(name, args, next)` runs them in registration order. Every handler
 * receives the **same original args**, followed by a **zero-argument** `next()`
 * that resumes the chain; only the return value is transformable. The terminal
 * `next()` increments `nextCalls`, so a pass-through is observable and a hook
 * that synthesizes a turn (returns its own iterable without calling `next()`)
 * leaves `nextCalls` at 0.
 *
 * `stream(sessionId, options?)` is the driver a test uses to simulate a real
 * model request: it runs the registered `llm/stream` waterfall with
 * `{ ...options, sessionId }` and records the resulting iterable for
 * `lastStream()`. When the waterfall never calls `next()`, the turn was
 * synthesized, so the fake increments `synthesized` itself — a test never has
 * to bump that counter by hand.
 *
 * Behaviour that no test exercises yet is the smallest honest implementation:
 * `receipts` is an empty array, `llm.stream` yields an empty stream, and
 * `tokenMeter` is empty because no estimator is installed (a test that needs
 * one overrides it).
 *
 * Prompt sections are recorded too, and `hooked()` reports `'systemPrompt'`
 * once one is registered, so a test can assert every mount point with one
 * call. A duplicate section name throws, mirroring the real host, and
 * `systemPrompt.section` returns a disposer.
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

/** The real spill backend's request shape; `owner` and `source` are required. */
type SaveTextInput = {
  owner?: { sessionId?: string }
  source?: { kind?: string; toolName?: string; callId?: string; label?: string }
  suggestedName: string
  content: string
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
  let lastSection: Section | undefined
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
        return emptyStream()
      },
    },
    systemPrompt: {
      section(section: Section): () => void {
        if (sections.has(section.name)) {
          throw new Error(`fakeHost: system prompt section "${section.name}" is already registered`)
        }
        sections.set(section.name, section)
        lastSection = section
        return () => {
          if (sections.get(section.name) !== section) return
          sections.delete(section.name)
          // `lastSection` tracks the last *registration*, not Map insertion
          // order, so disposing the newest section falls back to the previous.
          if (lastSection === section) lastSection = [...sections.values()].at(-1)
        }
      },
    },
    tokenMeter: {},
    spillStore: {
      saved: [] as SaveTextInput[],
      async saveText(input: SaveTextInput): Promise<{
        locator: string
        bytes: number
        retrievalHint: string
      }> {
        // Record the full request, including owner/source, so a caller that
        // omits the fields the real backend needs is observable in a test.
        host.spillStore.saved.push(input)
        return {
          locator: `/spill/${input.suggestedName}`,
          bytes: Buffer.byteLength(input.content, 'utf8'),
          retrievalHint: 'Read the full result with the read tool using offset/limit.',
        }
      },
    },

    // --- hook surface (real waterfall contract: fixed args, zero-arg next) ---
    on(name: string, handler: (...args: any[]) => unknown): void {
      const list = hooks.get(name) ?? []
      list.push(handler)
      hooks.set(name, list)
    },
    async callHook(
      name: string,
      args: readonly unknown[],
      next: () => unknown,
    ): Promise<unknown> {
      const handlers = hooks.get(name) ?? []
      const run = async (index: number): Promise<unknown> => {
        const handler = handlers[index]
        if (handler === undefined) {
          // Scope note: counts every waterfall pass-through, for any event.
          host.nextCalls += 1
          return next()
        }
        // The real waterfall throws when a listener resumes the chain twice
        // (cordis' "next() called multiple times"), so this fake does too: a
        // double-next regression must not pass the suite.
        let resumed = false
        const resume = (): unknown => {
          if (resumed) throw new Error(`fakeHost: next() called multiple times for ${name}`)
          resumed = true
          return run(index + 1)
        }
        return handler(...args, resume)
      }
      return run(0)
    },
    hooked(): string[] {
      const names = [...hooks.keys()]
      if (sections.size > 0) names.push('systemPrompt')
      return names
    },
    hookCount(name: string): number {
      return (hooks.get(name) ?? []).length
    },
    section(name?: string): Section | undefined {
      return name === undefined ? lastSection : sections.get(name)
    },

    // --- counters and receipts later tasks fill in ---
    receipts: [],
    nextCalls: 0,
    synthesized: 0,

    // --- stream driver: runs the llm/stream waterfall like the real host ---
    stream(sessionId: string, options: Partial<GenerateOptions> = {}): AsyncIterable<StreamChunk> {
      const request = { ...options, sessionId } as GenerateOptions
      let passedThrough = false
      const result = host.callHook('llm/stream', [request], () => {
        passedThrough = true
        return host.llm.stream(request)
      })
      // A hook that returns without calling `next()` substituted its own
      // turn, so the fake owns the count rather than each test bumping it.
      void result.then(
        () => {
          if (!passedThrough) host.synthesized += 1
        },
        () => {},
      )
      const iterable = (async function* () {
        yield* (await result) as AsyncIterable<StreamChunk>
      })()
      last = iterable
      return iterable
    },
    lastStream(): AsyncIterable<StreamChunk> | undefined {
      return last
    },

    // --- visibility probe over the registered definitions ---
    registered(name: string): boolean {
      return registrations.some(entry => (entry.def as { name?: unknown } | null)?.name === name)
    },
    async visible(name: string, agent: AgentLike): Promise<boolean> {
      const registration = registrations.find(
        entry => (entry.def as { name?: unknown } | null)?.name === name,
      )
      // Unregistered is not the same as "registered but invisible"; use
      // `registered(name)` when a test needs to tell the two apart.
      if (registration === undefined) return false
      if (registration.when === undefined) return true
      return Boolean(await registration.when({ agent, signal: new AbortController().signal }))
    },
  }

  return Object.assign(host, overrides)
}
