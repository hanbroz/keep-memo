'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { reconcileSelection } = require('../selection-reconcile')

test('바뀐 게 없으면 열 것도 내릴 것도 없다', () => {
  const r = reconcileSelection(['a', 'b'], ['a', 'b'])
  assert.deepStrictEqual(r.toOpen, [])
  assert.deepStrictEqual(r.toClose, [])
})

test('둘 다 비어 있어도 안전하다', () => {
  const r = reconcileSelection([], [])
  assert.deepStrictEqual(r.toOpen, [])
  assert.deepStrictEqual(r.toClose, [])
})

test('새로 체크한 것만 있으면 열기만 한다', () => {
  const r = reconcileSelection(['a'], ['a', 'b', 'c'])
  assert.deepStrictEqual(r.toOpen, ['b', 'c'])
  assert.deepStrictEqual(r.toClose, [])
})

test('체크를 푼 것만 있으면 내리기만 한다', () => {
  const r = reconcileSelection(['a', 'b', 'c'], ['b'])
  assert.deepStrictEqual(r.toOpen, [])
  assert.deepStrictEqual(r.toClose, ['a', 'c'])
})

test('열기와 내리기가 동시에 일어난다', () => {
  const r = reconcileSelection(['a', 'b'], ['b', 'c'])
  assert.deepStrictEqual(r.toOpen, ['c'])
  assert.deepStrictEqual(r.toClose, ['a'])
})

test('이미 떠 있는 메모를 체크해도 다시 열지 않는다', () => {
  // 다시 열면 편집 중이던 창이 새로 만들어져 미저장 편집이 사라진다.
  const r = reconcileSelection(['a', 'b'], ['a', 'b'])
  assert.ok(!r.toOpen.includes('a'))
  assert.ok(!r.toOpen.includes('b'))

  const r2 = reconcileSelection(['a'], ['a', 'z'])
  assert.deepStrictEqual(r2.toOpen, ['z'], '이미 떠 있는 a 는 빠지고 새 z 만 열린다')
})

test('바탕화면이 비어 있으면 체크한 것이 전부 열린다', () => {
  const r = reconcileSelection([], ['a', 'b'])
  assert.deepStrictEqual(r.toOpen, ['a', 'b'])
  assert.deepStrictEqual(r.toClose, [])
})

test('전부 체크를 풀면 전부 내려간다 — 그래도 지울 목록은 없다', () => {
  const r = reconcileSelection(['a', 'b'], [])
  assert.deepStrictEqual(r.toOpen, [])
  assert.deepStrictEqual(r.toClose, ['a', 'b'])
  assert.deepStrictEqual(Object.keys(r).sort(), ['toClose', 'toOpen'],
    '삭제/휴지통 목록은 이 함수의 결과에 존재하지 않는다')
})

test('중복 id 는 한 번만 나오고 입력 순서는 유지된다', () => {
  const r = reconcileSelection(['a', 'a'], ['b', 'c', 'b'])
  assert.deepStrictEqual(r.toOpen, ['b', 'c'])
  assert.deepStrictEqual(r.toClose, ['a'])
})

test('배열이 아니거나 이상한 원소가 섞여도 창 생성 경로로 새지 않는다', () => {
  const r = reconcileSelection(null, ['a', 42, null, '', undefined, 'b'])
  assert.deepStrictEqual(r.toOpen, ['a', 'b'])
  assert.deepStrictEqual(r.toClose, [])

  const r2 = reconcileSelection(['a'], undefined)
  assert.deepStrictEqual(r2.toOpen, [])
  assert.deepStrictEqual(r2.toClose, ['a'])
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof reconcileSelection, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
