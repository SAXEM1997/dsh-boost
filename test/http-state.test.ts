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
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  request(method: string, url: string, headers: Record<string, string>): Promise<{ status: number; body: Any }>
  setRegistry(registry: unknown): void
}

/**
 * Boots the real plugin over a fake host that provides a `webServer`.
 *
 * `webServer` is an override rather than a fixture member so the no-web-server
 * case is the same helper with the service left out.
 */
async function createServer(
  options: { webServer?: boolean; trustedHosts?: string[]; inject?: boolean } = {},
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
    async request(method, url, headers) {
      const route = routes[0]
      assert.ok(route !== undefined, 'the plugin mounted no route')
      const { out, res } = fakeResponse()
      await route.handler({ method, url, headers }, res)
      return { status: out.status, body: out.body === '' ? undefined : JSON.parse(out.body) }
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

test('非 GET/HEAD → 405', async () => {
  const server = await createServer()
  const { status, body } = await server.request('POST', `${HTTP_API_PREFIX}/state`, { host: LOOPBACK })
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
