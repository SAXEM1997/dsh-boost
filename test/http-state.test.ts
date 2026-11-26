/**
 * The assembly seam (spec S-1): the real `apply`, a fake host, and a fabricated
 * request instead of a socket.
 *
 * Nothing here reaches inside the handler: every assertion is about what a
 * caller of the route observes — status code and JSON body — because that is
 * all the page can see.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.ts'
import { fakeHost } from './fakes/host.ts'
import { HTTP_API_PREFIX } from '../src/http/state.ts'

type Any = any

const LOOPBACK = '127.0.0.1:23023'

const scopeDoc = () => ({
  version: 2,
  revision: 0,
  mode: 'selected',
  workspaceIds: [],
  shadow: true,
  projection: 'shadow',
})

/** A response recorder: the handler only ever calls these two methods. */
function fakeResponse(): { out: { status: number; headers: Any; body: string }; res: Any } {
  const out = { status: 0, headers: {} as Any, body: '' }
  return {
    out,
    res: {
      writeHead(status: number, headers?: Any): void {
        out.status = status
        out.headers = headers ?? {}
      },
      end(body?: string): void {
        out.body = body ?? ''
      },
    },
  }
}

interface Server {
  routes: { kind: string; path: string; handler: Any }[]
  warnings: string[]
  request(method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: Any }>
  setRegistry(registry: unknown): void
  readScope(): Promise<Any>
}

/**
 * Boots the real plugin over a fake host that provides a `webServer`.
 *
 * `webServer` is an override rather than a fixture member so the no-web-server
 * case is the same helper with the service left out.
 */
async function createServer(
  options: {
    webServer?: boolean
    trustedHosts?: string[]
    inject?: boolean
    /** The host's own admission verdict; absent means the host has no such service. */
    connection?: unknown
  } = {},
): Promise<Server> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-http-'))
  const root = join(dir, 'boost')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'scope.json'), `${JSON.stringify(scopeDoc())}\n`, 'utf8')

  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir

  const routes: Server['routes'] = []
  const warnings: string[] = []
  let registry: unknown = { list: () => [{ id: 'ws-1', path: '/workspace/one' }] }

  const webServer = {
    register(route: { kind: string; path: string; handler: Any }): () => void {
      routes.push(route)
      return () => {}
    },
  }

  const host = fakeHost({
    ...(options.inject === false ? { inject: undefined } : {}),
    get(name: string) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'webServer') return options.webServer === false ? undefined : webServer
      if (name === 'webStartup') return { trustedHosts: options.trustedHosts ?? [] }
      if (name === 'connection') return options.connection
      if (name === 'llm') return undefined
      return undefined
    },
    logger: {
      info: () => {},
      warn: (message: string) => warnings.push(message),
    },
  })

  plugin.apply(host, {})
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome

  return {
    routes,
    warnings,
    setRegistry(next: unknown): void {
      registry = next
    },
    async request(method, url, headers, body) {
      const route = routes[0]
      assert.ok(route !== undefined, 'the plugin mounted no route')
      const { out, res } = fakeResponse()
      // A write's request is a stream; a read's is not, and the handler must
      // tolerate both rather than assume one shape.
      const request: Any = { method, url, headers }
      if (body !== undefined) {
        request[Symbol.asyncIterator] = async function* () {
          yield Buffer.from(body, 'utf8')
        }
      }
      await route.handler(request, res)
      return { status: out.status, body: out.body === '' ? undefined : JSON.parse(out.body) }
    },
    readScope(): Promise<Any> {
      return readFile(join(root, 'scope.json'), 'utf8').then(text => JSON.parse(text))
    },
  }
}

test('挂一个 prefix 路由在插件自己的前缀上', async () => {
  const server = await createServer()
  assert.equal(server.routes.length, 1)
  assert.equal(server.routes[0]?.kind, 'prefix')
  assert.equal(server.routes[0]?.path, HTTP_API_PREFIX)
})

test('loopback 的 GET 拿到四块状态，工作区列表可用', async () => {
  const server = await createServer()
  const { status, body } = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
  assert.equal(status, 200)
  assert.deepEqual(Object.keys(body).sort(), ['config', 'scope', 'status', 'workspaces'])
  assert.equal(body.workspaces.available, true)
  assert.deepEqual(body.workspaces.entries, [{ id: 'ws-1', path: '/workspace/one' }])
})

test('status 与 scope 和 boost 工具读的是同一份', async () => {
  const server = await createServer()
  const { body } = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
  // The planted document, read back through the page's route. A second
  // computation would show a different revision or a defaulted field.
  assert.equal(body.scope.ok, true)
  assert.equal(body.scope.data.revision, 0)
  assert.equal(body.scope.data.mode, 'selected')
  assert.deepEqual(body.scope.data.workspaceIds, [])
  assert.equal(body.status.ok, true)
})

test('Origin 与 Host 不一致 → 403', async () => {
  const server = await createServer()
  const { status, body } = await server.request('GET', `${HTTP_API_PREFIX}/state`, {
    host: LOOPBACK,
    origin: 'http://evil.example',
  })
  assert.equal(status, 403)
  assert.equal(body.error, 'ERR_HTTP_FORBIDDEN')
})

test('同源 Origin → 放行', async () => {
  const server = await createServer()
  const { status } = await server.request('GET', `${HTTP_API_PREFIX}/state`, {
    host: LOOPBACK,
    origin: `http://${LOOPBACK}`,
  })
  assert.equal(status, 200)
})

test('没有 Origin 的读请求放行（curl 与同源 GET 都没有这个头）', async () => {
  const server = await createServer()
  const { status } = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
  assert.equal(status, 200)
})

test('sec-fetch-site: cross-site → 403', async () => {
  const server = await createServer()
  const { status } = await server.request('GET', `${HTTP_API_PREFIX}/state`, {
    host: LOOPBACK,
    'sec-fetch-site': 'cross-site',
  })
  assert.equal(status, 403)
})

test('非 loopback 且不在 trustedHosts → 403', async () => {
  const server = await createServer()
  const { status } = await server.request('GET', `${HTTP_API_PREFIX}/state`, {
    host: 'dsh.example.com:23000',
  })
  assert.equal(status, 403)
})

test('webStartup 声明的 trustedHosts 让局域网 Host 通过', async () => {
  const server = await createServer({ trustedHosts: ['dsh.example.com:23000'] })
  const { status } = await server.request('GET', `${HTTP_API_PREFIX}/state`, {
    host: 'dsh.example.com:23000',
  })
  assert.equal(status, 200)
})

test('没有 Host 头 → 403', async () => {
  const server = await createServer()
  const { status } = await server.request('GET', `${HTTP_API_PREFIX}/state`, {})
  assert.equal(status, 403)
})

test('读路由不接受写方法', async () => {
  const server = await createServer()
  for (const method of ['PUT', 'POST']) {
    const { status, body } = await server.request(method, `${HTTP_API_PREFIX}/state`, {
      host: LOOPBACK,
      origin: `http://${LOOPBACK}`,
    })
    assert.equal(status, 405, `${method} /state`)
    assert.equal(body.error, 'ERR_HTTP_METHOD', `${method} /state`)
  }
})

test('GET /scope → 405：路径存在但只接受 POST', async () => {
  const server = await createServer()
  const { status, body } = await server.request('GET', `${HTTP_API_PREFIX}/scope`, { host: LOOPBACK })
  assert.equal(status, 405)
  assert.equal(body.error, 'ERR_HTTP_METHOD')
})

test('未知子路径 → 404，且是 JSON', async () => {
  const server = await createServer()
  const { status, body } = await server.request('GET', `${HTTP_API_PREFIX}/nope`, { host: LOOPBACK })
  assert.equal(status, 404)
  assert.equal(body.error, 'ERR_HTTP_NOT_FOUND')
})

test('registry 抛错 → available:false，不是空列表', async () => {
  const server = await createServer()
  server.setRegistry({
    list() {
      throw new Error('registry is gone')
    },
  })
  const { body } = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
  assert.equal(body.workspaces.available, false)
  assert.equal(body.workspaces.code, 'ERR_HTTP_WORKSPACES_UNAVAILABLE')
})

test('没有 webServer 的部署：不挂路由，也不抛', async () => {
  const server = await createServer({ webServer: false })
  // Dynamic injection cannot tell "not yet" from "never", so silence is the
  // correct outcome here — the real host leaves the callback pending for the
  // life of the process. A warning would fire on every headless boot.
  assert.equal(server.routes.length, 0)
})

test('没有动态注入能力的宿主：warn 一次、不挂路由', async () => {
  const server = await createServer({ inject: false })
  assert.equal(server.routes.length, 0)
  assert.ok(server.warnings.some(message => message.includes('settings page has no data route')))
})

// --- writes: same CAS as the tool, same fence as reads, stricter on Origin ---

const ORIGIN = `http://${LOOPBACK}`

test('写：同源 POST 改字段，盘上的 scope.json 立刻反映', async () => {
  const server = await createServer()
  const { status, body } = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK, origin: ORIGIN },
    JSON.stringify({ body: { mode: 'global', shadow: false }, baseRevision: 0 }),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  // The file is the source of truth, not the response: a 200 that did not
  // persist would still look like success to the page.
  const doc = await server.readScope()
  assert.equal(doc.mode, 'global')
  assert.equal(doc.shadow, false)
  assert.equal(doc.revision, 1)
})

test('写：保存移除 stale id 后的 workspaceIds → 读回也只剩注册表里的', async () => {
  const server = await createServer()
  // Plant the document a stale row comes from: the registry has ws-1, the
  // saved document still names ws-gone. Removing ws-gone is the page's draft
  // change, and this is the round trip that proves the route persists it.
  const planted = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK, origin: ORIGIN },
    JSON.stringify({ body: { workspaceIds: ['ws-1', 'ws-gone'] }, baseRevision: 0 }),
  )
  assert.equal(planted.status, 200)

  const saved = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK, origin: ORIGIN },
    JSON.stringify({ body: { workspaceIds: ['ws-1'] }, baseRevision: 1 }),
  )
  assert.equal(saved.status, 200)
  assert.deepEqual((await server.readScope()).workspaceIds, ['ws-1'])

  const { body } = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
  assert.equal(body.scope.ok, true)
  assert.deepEqual(body.scope.data.workspaceIds, ['ws-1'])
})

test('写：没有 Origin 头 → 403（浏览器对 POST 一定带它）', async () => {
  const server = await createServer()
  const { status, body } = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK },
    JSON.stringify({ body: { mode: 'global' }, baseRevision: 0 }),
  )
  assert.equal(status, 403)
  assert.equal(body.error, 'ERR_HTTP_FORBIDDEN')
  assert.equal((await server.readScope()).mode, 'selected')
})

test('写：跨站 Origin → 403', async () => {
  const server = await createServer()
  const { status } = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK, origin: 'http://evil.example' },
    JSON.stringify({ body: { mode: 'global' }, baseRevision: 0 }),
  )
  assert.equal(status, 403)
})

test('写：过期的 baseRevision → 409 且文件不动', async () => {
  const server = await createServer()
  // Someone else writes first — this is the concurrent-writer case.
  await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK, origin: ORIGIN },
    JSON.stringify({ body: { mode: 'global' }, baseRevision: 0 }),
  )
  const { status, body } = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK, origin: ORIGIN },
    JSON.stringify({ body: { mode: 'selected' }, baseRevision: 0 }),
  )
  assert.equal(status, 409)
  assert.equal(body.error, 'ERR_SCOPE_REVISION_CONFLICT')
  assert.equal((await server.readScope()).mode, 'global')
})

test('写：字段非法 → 400 且带插件的码', async () => {
  const server = await createServer()
  const { status, body } = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK, origin: ORIGIN },
    JSON.stringify({ body: { mode: 'everything' }, baseRevision: 0 }),
  )
  assert.equal(status, 400)
  assert.equal(body.error, 'ERR_BOOST_INVALID_BODY')
})

test('写：body 不是 JSON → 400', async () => {
  const server = await createServer()
  const { status, body } = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK, origin: ORIGIN },
    'not json at all',
  )
  assert.equal(status, 400)
  assert.equal(body.error, 'ERR_HTTP_BODY')
})

test('写：超过 64 KiB 的 body 被拒，不是被截断后照写', async () => {
  const server = await createServer()
  const huge = JSON.stringify({ body: { workspaceIds: ['x'.repeat(70 * 1024)] }, baseRevision: 0 })
  const { status, body } = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK, origin: ORIGIN },
    huge,
  )
  assert.equal(status, 400)
  assert.equal(body.error, 'ERR_HTTP_BODY')
  assert.equal((await server.readScope()).revision, 0)
})

test('写：未知写路径 → 404', async () => {
  const server = await createServer()
  const { status } = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/shadow`,
    { host: LOOPBACK, origin: ORIGIN },
    JSON.stringify({ body: true, baseRevision: 0 }),
  )
  assert.equal(status, 404)
})

test('host admission rejection answers 401 and names only the code', async () => {
  const server = await createServer({ connection: { admit: () => ({ rejection: 401 }) } })
  const response = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
  assert.equal(response.status, 401)
  assert.deepEqual(response.body, { error: 'ERR_HTTP_UNAUTHORIZED' })
})

test('host admission runs before the fence, so its verdict wins on an untrusted Host', async () => {
  const server = await createServer({ connection: { admit: () => ({ rejection: 401 }) } })
  // The fence would answer 403 for this Host; a 401 proves admission ran first.
  const response = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: 'evil.example' })
  assert.equal(response.status, 401)
  assert.deepEqual(response.body, { error: 'ERR_HTTP_UNAUTHORIZED' })
})

test('a 403 verdict keeps the fence code rather than the auth code', async () => {
  const server = await createServer({ connection: { admit: () => ({ rejection: 403 }) } })
  const response = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
  assert.equal(response.status, 403)
  assert.deepEqual(response.body, { error: 'ERR_HTTP_FORBIDDEN' })
})

test('a verdict this route has no code for answers 500, not an auth failure', async () => {
  const server = await createServer({ connection: { admit: () => ({ rejection: 418 }) } })
  const response = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
  assert.equal(response.status, 500)
  assert.deepEqual(response.body, { error: 'ERR_HTTP_INTERNAL' })
})

test('host admission rejection stops a write before the document moves', async () => {
  const server = await createServer({ connection: { admit: () => ({ rejection: 401 }) } })
  // A *valid* envelope: with a malformed one the handler would answer 400 on its
  // own, and "the document did not move" would prove nothing about admission.
  const response = await server.request(
    'POST',
    `${HTTP_API_PREFIX}/scope`,
    { host: LOOPBACK, origin: `http://${LOOPBACK}`, 'content-type': 'application/json' },
    JSON.stringify({
      body: { mode: 'global', workspaceIds: [], shadow: false, projection: 'on' },
      baseRevision: 0,
    }),
  )
  assert.equal(response.status, 401)
  assert.deepEqual(response.body, { error: 'ERR_HTTP_UNAUTHORIZED' })
  const after = await server.readScope()
  assert.equal(after.mode, 'selected')
  assert.equal(after.projection, 'shadow')
  assert.equal(after.revision, 0)
})

test('an admission check that throws is a refusal, not permission', async () => {
  const server = await createServer({
    connection: {
      admit: () => {
        throw new Error('connection service is broken')
      },
    },
  })
  const response = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
  assert.equal(response.status, 401)
  assert.deepEqual(response.body, { error: 'ERR_HTTP_UNAUTHORIZED' })
})

test('a host with no admission service still serves the page', async () => {
  const server = await createServer({})
  const response = await server.request('GET', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
  assert.equal(response.status, 200)
})
