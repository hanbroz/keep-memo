'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Store, DEFAULT_NOTE_STATE } = require('../store')

function tmpFile () {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ks-')), 'state.json')
}

test('파일이 없으면 빈 상태로 시작한다', () => {
  const s = new Store(tmpFile())
  s.load()
  assert.deepStrictEqual(s.visibleIds(), [])
})

test('저장한 뒤 다시 읽으면 값이 유지된다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  a.setNote('n1', { x: 10, y: 20, visible: true })
  a.save()

  const b = new Store(file)
  b.load()
  assert.strictEqual(b.getNote('n1').x, 10)
  assert.deepStrictEqual(b.visibleIds(), ['n1'])
})

test('새 노트는 기본값으로 채워진다', () => {
  const s = new Store(tmpFile())
  s.load()
  s.setNote('n1', { visible: true })
  assert.strictEqual(s.getNote('n1').w, DEFAULT_NOTE_STATE.w)
  assert.strictEqual(s.getNote('n1').conflictBackup, null)
})

test('손상된 JSON 이어도 앱이 죽지 않고 빈 상태로 시작한다', () => {
  const file = tmpFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{깨진 JSON', 'utf8')
  const s = new Store(file)
  s.load()
  assert.deepStrictEqual(s.visibleIds(), [])
})

test('visible 이 false 인 노트는 목록에서 빠진다', () => {
  const s = new Store(tmpFile())
  s.load()
  s.setNote('n1', { visible: true })
  s.setNote('n2', { visible: false })
  assert.deepStrictEqual(s.visibleIds(), ['n1'])
})

test('이메일을 저장한 뒤 다시 읽으면 값이 유지된다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  a.setEmail('you@gmail.com')
  a.save()

  const b = new Store(file)
  b.load()
  assert.strictEqual(b.getEmail(), 'you@gmail.com')
})

test('이메일을 설정한 적이 없으면 null 이다', () => {
  const s = new Store(tmpFile())
  s.load()
  assert.strictEqual(s.getEmail(), null)
})
