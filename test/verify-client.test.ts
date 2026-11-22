/**
 * Ticket T2 (spec #2): the publish gate's structural assertions on the browser
 * half, driven with constructed artifacts.
 *
 * The gate itself is exercised end to end by `npm run verify:package`, but that
 * path installs the tarball twice and is far too slow to prove eight separate
 * negative cases. What matters for each negative is that a SPECIFIC mutation
 * makes the gate fail, so the assertion is imported and mutated here; the
 * end-to-end failure is reproduced in `docs/RELEASE.md` §1.0.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
// The script ships no declarations: it is a Node entry point, not a library.
// @ts-expect-error - .mjs without a .d.ts
import { assertClientBundleText } from '../scripts/verify-package.mjs'

const PACKAGE_NAME = 'dsh-boost'

/** The smallest artifact that satisfies every clause of the contract. */
const VALID = `window.__ModuleLoader__.load({
  id: "dsh-boost",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const jsxRuntime = require("react/jsx-runtime");
    exports.apply = function apply() {};
    exports.inject = ["slots"];
    return module.exports;
  }
});
`

function mutated(edit: (text: string) => string): string {
  return edit(VALID)
}

test('the gate accepts a well-formed client bundle', () => {
  assert.doesNotThrow(() => assertClientBundleText(VALID, PACKAGE_NAME))
})

test('the gate rejects a bundle with no loader envelope', () => {
  const text = mutated((s) => s.replace('window.__ModuleLoader__.load({', '(function () {'))
  assert.throws(() => assertClientBundleText(text, PACKAGE_NAME), /envelope/)
})

test('the gate rejects a bundle registered under another id', () => {
  const text = mutated((s) => s.replace('id: "dsh-boost"', 'id: "dsh-boost-old"'))
  assert.throws(() => assertClientBundleText(text, PACKAGE_NAME), /does not register under id/)
})

test('the gate rejects a bundle whose factory takes no resolver', () => {
  // A factory with no parameter cannot reach the host module table at all, so
  // its React is whatever got bundled — the clause that catches it is the one
  // that would otherwise never fire.
  const text = mutated((s) => s.replace('factory: (require) => {', 'factory: () => {'))
  assert.throws(() => assertClientBundleText(text, PACKAGE_NAME), /factory/)
})

test('the gate rejects a bundle that does not export apply', () => {
  const text = mutated((s) => s.replace('exports.apply = function apply() {};', ''))
  assert.throws(() => assertClientBundleText(text, PACKAGE_NAME), /does not export `apply`/)
})

test('the gate rejects a bundle that does not export inject', () => {
  const text = mutated((s) => s.replace('exports.inject = ["slots"];', ''))
  assert.throws(() => assertClientBundleText(text, PACKAGE_NAME), /does not export `inject`/)
})

test('the gate rejects a bundle that never resolves React through the host', () => {
  const text = mutated((s) => s.replace('require("react/jsx-runtime")', 'jsxRuntime'))
  assert.throws(() => assertClientBundleText(text, PACKAGE_NAME), /never resolves React/)
})

test('the gate rejects a bundle that pulls in a host package', () => {
  // Host packages are supplied by the shell; importing one here inlines a
  // second copy, and the gate's "resolves host modules through require" claim
  // would otherwise be unenforced for everything except React.
  // React still resolves through the host — this bundle additionally pulls a
  // host package, which is the case the React clause alone cannot see.
  const text = mutated((s) =>
    s.replace('exports.apply =', 'const tools = require("@deepseek-ai/dsh-tools");\n    exports.apply ='),
  )
  assert.throws(() => assertClientBundleText(text, PACKAGE_NAME), /@deepseek-ai/)
})

test('the gate rejects a bundle with React inlined', () => {
  const text = mutated((s) => `${s}\nvar REACT_ELEMENT_TYPE = Symbol.for("react.element");\n`)
  assert.throws(() => assertClientBundleText(text, PACKAGE_NAME), /inlines React/)
})

test('the gate rejects a bundle built with the dev JSX transform', () => {
  const text = mutated((s) => s.replace('require("react/jsx-runtime")', 'require("react/jsx-dev-runtime")'))
  assert.throws(() => assertClientBundleText(text, PACKAGE_NAME), /jsx-dev-runtime/)
})
