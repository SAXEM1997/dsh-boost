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
 * that resumes the chain; only the return value is transformable. For every
 * event except `llm/stream`, the terminal `next()` increments `nextCalls`, so a
 * pass-through is observable.
 *
 * `llm/stream` is the one **synchronous** waterfall: `next()` returns the
 * downstream `AsyncIterable` directly, and an `async` listener would hand the
 * host a `Promise<AsyncIterable>` (appendix §7). `runStream` runs that chain
 * synchronously.
 *
 * `stream(sessionId, options?)` is the driver a test uses to simulate a real
 * model request: it runs the registered `llm/stream` waterfall with
 * `{ ...options, sessionId }` and records the resulting iterable for
 * `lastStream()`. Its terminal mirrors the real host's lazy async generator:
 * resolving `next()` starts nothing, and `nextCalls`/the model stream advance
 * only when the returned iterator is pulled. A turn that completes without
 * pulling the upstream was synthesized, so the fake increments `synthesized`
 * itself — a test never has to bump that counter by hand.
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

  const register = (def: unknown, opts?: { when?: Registered['when'] }): void => {
    registrations.push({ def, when: opts?.when })
  }
  const resolve = (): readonly unknown[] => registrations.map(registration => registration.def)

  const host: any = {
    // --- tool registry: record the definition and its `when` predicate ---
    // `tools` mirrors these three at the service path `PluginContext` declares
    // (`ctx.tools.register`); the top-level copies stay for the older tests that
    // treat the fake itself as the service.
    register,
    resolve,
    definitions: registrations,
    tools: { register, resolve, definitions: registrations },

    /**
     * Cordis's dynamic injection: run `callback` in a child fiber once every
     * named service exists.
     *
     * The fake resolves immediately when the services are present and does
     * nothing when they are not. The real host would run the callback later,
     * when the provider's fiber activates; no test at this seam depends on
     * that timing, and the plugin's own code must tolerate both.
     */
    inject(names: string[], callback: (context: Record<string, unknown>) => void): () => void {
      // Resolved through `get`, exactly as cordis resolves a service name: a
      // test that supplies a service by overriding `get` must be visible here
      // too, or the fake would model a lookup the host does not perform.
      const resolved = names.map(name => host.get(name))
      if (resolved.some(value => value === undefined)) return () => {}
      const context: Record<string, unknown> = {}
      names.forEach((name, index) => { context[name] = resolved[index] })
      callback(context)
      return () => {}
    },
    /** The un-gated service read: what `ctx.get('webStartup')` does. */
    get(name: string): unknown {
      return host[name]
    },

    // --- host services ---
    llm: {
      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        return emptyStream()
      },
    },
    systemPrompt: {
      section(section: Section): () => void {
        if (sections.has(section.name)) {
          // The real host's wording: a plain Error whose message names the
          // section and says it is already registered. `apply` classifies a
          // duplicate mount on exactly that message.
          throw new Error(
            `prompt section "${section.name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`,
          )
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
    /**
     * Register one listener, honouring cordis's `prepend` option.
     *
     * Cordis runs the first-registered listener outermost, so a listener
     * registered with `{ prepend: true }` (or the boolean shorthand) must run
     * before every earlier one. Recording the real order is what lets a test
     * catch a detector that was mounted after the hook it must precede.
     */
    on(
      name: string,
      handler: (...args: any[]) => unknown,
      options?: boolean | { prepend?: boolean },
    ): void {
      const list = hooks.get(name) ?? []
      const prepend = options === true || (typeof options === 'object' && options?.prepend === true)
      if (prepend) list.unshift(handler)
      else list.push(handler)
      hooks.set(name, list)
    },
    /**
     * Run a waterfall with a synchronous `next()`.
     *
     * `llm/stream` is a synchronous waterfall: `next()` returns the downstream
     * `AsyncIterable` directly, and an `async` listener would hand the host a
     * `Promise<AsyncIterable>` that `for await` cannot consume (appendix §7).
     * The generic `callHook` below is async because every other event is; this
     * runner is what models the model-request contract.
     */
    runStream(name: string, args: readonly unknown[], next: () => unknown): unknown {
      const handlers = hooks.get(name) ?? []
      const run = (index: number): unknown => {
        const handler = handlers[index]
        if (handler === undefined) return next()
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
    async callHook(
      name: string,
      args: readonly unknown[],
      next: () => unknown,
    ): Promise<unknown> {
      // `llm/stream` keeps its synchronous `next()` even through this generic
      // driver, so a listener that expects the real contract sees it.
      if (name === 'llm/stream') {
        return host.runStream(name, args, () => {
          host.nextCalls += 1
          return next()
        })
      }
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
      // The real host's terminal is an async generator (`adapterStream`): calling
      // `next()` only creates it, and the model request starts when it is first
      // pulled. The hook now resolves `next()` eagerly on every path, so the
      // counters must follow consumption, not resolution.
      let upstreamStarted = false
      const result = host.runStream('llm/stream', [request], () => {
        return (async function* () {
          upstreamStarted = true
          host.nextCalls += 1
          yield* host.llm.stream(request)
        })()
      })
      if (typeof (result as AsyncIterable<StreamChunk> | undefined)?.[Symbol.asyncIterator] !== 'function') {
        throw new Error('fakeHost: an llm/stream listener must return an AsyncIterable synchronously')
      }
      // A turn is synthesized when the returned stream completes without ever
      // pulling the upstream iterator; the fake owns that count rather than each
      // test bumping it. It is recorded at completion because eager resolution
      // alone no longer proves the model answered.
      const observed = (async function* (): AsyncGenerator<StreamChunk> {
        try {
          yield* (result as AsyncIterable<StreamChunk>)
        } finally {
          if (!upstreamStarted) host.synthesized += 1
        }
      })()
      last = observed
      return last
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
