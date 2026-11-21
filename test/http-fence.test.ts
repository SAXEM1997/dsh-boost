/**
 * Ticket T3 (spec #2, user story 28): the same-origin fence.
 *
 * These are pure cases — the fence takes a header bag and returns a boolean —
 * because every interesting branch is a header combination, and driving them
 * through a real socket would test Node's HTTP parser instead.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackHostname, isTrustedWebRequest, parseAuthority } from '../src/http/fence.ts'

const LOOPBACK = { headers: { host: '127.0.0.1:23023' } }
const LAN = { headers: { host: 'dsh.home.iridesc.cn:23000' } }
const TRUSTED = ['dsh.home.iridesc.cn:23000', '192.168.50.216']

test('a loopback read with no Origin is served', () => {
  // The settings page's own GET carries no Origin — see the module comment.
  assert.equal(isTrustedWebRequest(LOOPBACK), true)
})

test('a declared LAN host read is served', () => {
  assert.equal(isTrustedWebRequest(LAN, { trustedHosts: TRUSTED }), true)
})

test('an undeclared host is refused', () => {
  // DNS rebinding: the browser resolved attacker.example to this server.
  const rebound = { headers: { host: 'attacker.example:23023' } }
  assert.equal(isTrustedWebRequest(rebound, { trustedHosts: TRUSTED }), false)
})

test('a declared host with no port matches any port', () => {
  const anyPort = { headers: { host: '192.168.50.216:41234' } }
  assert.equal(isTrustedWebRequest(anyPort, { trustedHosts: TRUSTED }), true)
})

test('an Origin that disagrees with Host is refused', () => {
  const crossSite = { headers: { host: '127.0.0.1:23023', origin: 'https://evil.example' } }
  assert.equal(isTrustedWebRequest(crossSite), false)
})

test('an Origin that agrees with Host is served', () => {
  const sameOrigin = { headers: { host: '127.0.0.1:23023', origin: 'http://127.0.0.1:23023' } }
  assert.equal(isTrustedWebRequest(sameOrigin), true)
})

test('an unparseable Origin is refused rather than ignored', () => {
  const malformed = { headers: { host: '127.0.0.1:23023', origin: 'not a url' } }
  assert.equal(isTrustedWebRequest(malformed), false)
})

test('sec-fetch-site: cross-site is refused even with a matching Origin', () => {
  const crossSite = {
    headers: { host: '127.0.0.1:23023', origin: 'http://127.0.0.1:23023', 'sec-fetch-site': 'cross-site' },
  }
  assert.equal(isTrustedWebRequest(crossSite), false)
})

test('a write route refuses an absent Origin', () => {
  // Reads admit curl; writes do not, because no browser omits Origin on POST.
  assert.equal(isTrustedWebRequest(LOOPBACK, { requireOrigin: true }), false)
  const browserWrite = { headers: { host: '127.0.0.1:23023', origin: 'http://127.0.0.1:23023' } }
  assert.equal(isTrustedWebRequest(browserWrite, { requireOrigin: true }), true)
})

test('a request with no Host header is refused', () => {
  assert.equal(isTrustedWebRequest({ headers: {} }), false)
})

test('a malformed Host header is refused', () => {
  assert.equal(isTrustedWebRequest({ headers: { host: 'not a host' } }), false)
})

test('the header bag accepts the array form Node allows', () => {
  assert.equal(isTrustedWebRequest({ headers: { host: ['127.0.0.1:23023', 'other'] } }), true)
})

test('authority parsing keeps the port and flags a bare entry', () => {
  assert.deepEqual(parseAuthority('127.0.0.1:23023'), { hostname: '127.0.0.1', host: '127.0.0.1:23023', bare: false })
  assert.deepEqual(parseAuthority('dsh.home.iridesc.cn'), {
    hostname: 'dsh.home.iridesc.cn',
    host: 'dsh.home.iridesc.cn',
    bare: true,
  })
  assert.equal(parseAuthority(''), undefined)
  assert.equal(parseAuthority(undefined), undefined)
})

test('loopback detection covers the whole 127/8 and the IPv6 forms', () => {
  for (const name of ['localhost', '127.0.0.1', '127.0.0.53', '::1', '[::1]']) {
    assert.equal(isLoopbackHostname(name), true, name)
  }
  for (const name of ['10.0.0.1', '192.168.50.216', 'example.com', '[fe80::1]']) {
    assert.equal(isLoopbackHostname(name), false, name)
  }
})
