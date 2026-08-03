'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { orphanedNoteIds } = require('../sync-reconcile')

test('최신 목록에 그대로 있으면 고아가 아니다', () => {
  const r = orphanedNoteIds(['a', 'b'], [{ id: 'a' }, { id: 'b' }])
  assert.deepStrictEqual(r, [])
})

test('열려 있는데 최신 목록에 없으면 고아다', () => {
  const r = orphanedNoteIds(['a', 'b'], [{ id: 'a' }])
  assert.deepStrictEqual(r, ['b'])
})

test('둘 다 비어 있어도 안전하다', () => {
  assert.deepStrictEqual(orphanedNoteIds([], []), [])
})

test('열린 창이 하나도 없으면 고아도 없다', () => {
  assert.deepStrictEqual(orphanedNoteIds([], [{ id: 'a' }]), [])
})

test('최신 목록이 비어 있으면 열린 것 전부가 고아다', () => {
  assert.deepStrictEqual(orphanedNoteIds(['a', 'b', 'c'], []), ['a', 'b', 'c'])
})

test('입력 순서를 유지한다', () => {
  const r = orphanedNoteIds(['c', 'a', 'b'], [{ id: 'a' }])
  assert.deepStrictEqual(r, ['c', 'b'])
})

test('이상한 입력이 와도 창 정리 경로로 새지 않는다', () => {
  assert.deepStrictEqual(orphanedNoteIds(null, [{ id: 'a' }]), [])
  assert.deepStrictEqual(orphanedNoteIds(undefined, [{ id: 'a' }]), [])
  assert.deepStrictEqual(orphanedNoteIds(['a'], null), ['a'])
  assert.deepStrictEqual(orphanedNoteIds(['a'], undefined), ['a'])
  assert.deepStrictEqual(
    orphanedNoteIds(['a', 42, null, '', undefined, 'b'], [{ id: 'b' }]),
    ['a']
  )
  assert.deepStrictEqual(
    orphanedNoteIds(['a', 'b'], [{ id: 42 }, { id: '' }, null, { id: 'a' }]),
    ['b']
  )
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof orphanedNoteIds, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
