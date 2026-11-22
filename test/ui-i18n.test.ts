/**
 * The two dictionaries, and the two ways the page can be translated (spec S-3).
 *
 * A key present in one language and absent from the other is invisible in
 * Chinese and shows a raw identifier in English — the failure only surfaces for
 * the half of the audience that reads the other language, which is exactly the
 * kind of bug a test has to catch for you.
 */
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import en from '../locale/en.json' with { type: 'json' }
import zh from '../locale/zh.json' with { type: 'json' }
import { DICTIONARIES, KEYS, LOCALE_NAMESPACE, fallbackT, setTranslator } from '../ui/src/i18n.ts'
import { copyOf } from '../ui/src/copy.ts'

test('中英字典键集相等', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('两份字典都没有空串', () => {
  for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${language}/${key} is empty`)
    }
  }
})

test('没有 locale 服务时用兜底语言，且不是裸键', () => {
  setTranslator(fallbackT)
  const c = copyOf(fallbackT)
  for (const key of KEYS) {
    assert.notEqual(c[key as keyof typeof c], key, `${key} rendered as its own key`)
  }
  assert.equal(fallbackT('TITLE'), zh.TITLE as string)
})

test('页面引用的每个键都在字典里', () => {
  // Discovered from the components rather than restated: a key the page reads
  // but the dictionary lacks renders as the key itself, which is the bug this
  // pins. Both files, because App and ScopeForm each read their own keys.
  const sources = ['ui/src/App.tsx', 'ui/src/ScopeForm.tsx'].map(file =>
    readFileSync(join(import.meta.dirname, '..', file), 'utf8'),
  )
  const referenced = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/\bc\.([A-Z][A-Z0-9_]*)/g)) referenced.add(match[1] as string)
    for (const match of source.matchAll(/\bt\(['"]([A-Za-z0-9_.]+)['"]\)/g)) referenced.add(match[1] as string)
  }
  assert.ok(referenced.size > 20, `discovered only ${referenced.size} keys; the scan is broken`)
  const missing = [...referenced].filter(key => !(key in zh))
  assert.deepEqual(missing, [], `the page reads keys the dictionary lacks: ${missing.join(', ')}`)
})

test('换翻译器后同一份 copy 的取值跟着变', () => {
  const english = (key: string) => (en as unknown as Record<string, string>)[key] ?? key
  setTranslator(fallbackT)
  const before = copyOf(fallbackT).TITLE
  setTranslator(english)
  const after = copyOf(english).TITLE
  assert.equal(before, zh.TITLE as string)
  assert.equal(after, en.TITLE as string)
  assert.notEqual(before, after)
  setTranslator(fallbackT)
})

test('命名空间是稳定的：宿主按它注册与绑定', () => {
  assert.equal(LOCALE_NAMESPACE, 'dsh-boost')
})
