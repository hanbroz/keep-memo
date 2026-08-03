'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Store, DEFAULT_NOTE_STATE } = require('../store')
const { DEFAULT_FONT_SETTINGS } = require('../renderer/font-settings')

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

test('새 노트는 접히지 않은 상태로 시작한다', () => {
  const s = new Store(tmpFile())
  s.load()
  s.setNote('n1', { visible: true })
  assert.strictEqual(s.getNote('n1').folded, false)
})

test('접힌 채로 재시작해도 folded 와 펼친 기하가 함께 살아남는다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  a.setNote('n1', { x: 700, y: 300, w: 320, h: 380, visible: true, folded: true })
  a.save()

  const b = new Store(file)
  b.load()
  const n = b.getNote('n1')
  assert.strictEqual(n.folded, true)
  assert.deepStrictEqual([n.x, n.y, n.w, n.h], [700, 300, 320, 380],
    '펼친 상태의 기하가 책갈피 좌표로 덮이지 않았다')
  assert.deepStrictEqual(b.visibleIds(), ['n1'], '접힌 메모도 바탕화면에 있는 것으로 센다')
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

test('서체 설정을 저장한 적이 없으면 기본값이 나온다', () => {
  const s = new Store(tmpFile())
  s.load()
  assert.deepStrictEqual(s.getFontSettings(), DEFAULT_FONT_SETTINGS)
})

test('서체 설정을 저장한 뒤 다시 읽으면 값이 유지된다 — 앱을 껐다 켜도 남는다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  a.setFontSettings({ family: 'batang', titlePt: 14, bodyPt: 11 })
  a.save()

  const b = new Store(file)
  b.load()
  assert.deepStrictEqual(b.getFontSettings(), { family: 'batang', titlePt: 14, bodyPt: 11 })
})

test('서체 설정은 이메일/노트와 나란히 살고 서로를 지우지 않는다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  a.setEmail('you@gmail.com')
  a.setNote('n1', { visible: true })
  a.setFontSettings({ family: 'consolas', titlePt: 11, bodyPt: 10 })
  a.save()

  const b = new Store(file)
  b.load()
  assert.strictEqual(b.getEmail(), 'you@gmail.com')
  assert.deepStrictEqual(b.visibleIds(), ['n1'])
  assert.strictEqual(b.getFontSettings().family, 'consolas')
})

test('말도 안 되는 크기는 state.json 에 들어가기 전에 걸러진다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  const saved = a.setFontSettings({ family: '없는글꼴', titlePt: 999, bodyPt: '아무거나' })
  assert.deepStrictEqual(saved,
    { family: DEFAULT_FONT_SETTINGS.family, titlePt: 24, bodyPt: DEFAULT_FONT_SETTINGS.bodyPt })
  a.save()

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepStrictEqual(onDisk.fonts, saved, '파일에는 검증을 지난 값만 남는다')
})

test('state.json 을 손으로 고쳐 이상한 서체 설정을 넣어도 화면까지 오지 않는다', () => {
  const file = tmpFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ fonts: { family: 'evil', titlePt: -3, bodyPt: 500 } }), 'utf8')
  const s = new Store(file)
  s.load()
  assert.deepStrictEqual(s.getFontSettings(),
    { family: DEFAULT_FONT_SETTINGS.family, titlePt: 6, bodyPt: 24 })
})

// --- 노트별 서체 재정의 -------------------------------------------------------

test('노트별 서체 재정의는 없는 것이 기본이다 — null 이면 전역을 따른다', () => {
  const s = new Store(tmpFile())
  s.load()
  s.setNote('n1', { visible: true })
  assert.strictEqual(s.getNote('n1').font, null)
  assert.strictEqual(s.getNoteFont('n1'), null)
})

test('한 번도 본 적 없는 id 의 서체를 물어도 null 이고 항목을 만들지 않는다', () => {
  const s = new Store(tmpFile())
  s.load()
  assert.strictEqual(s.getNoteFont('없는id'), null)
  assert.strictEqual(s.getNote('없는id'), null)
})

test('노트별 서체 재정의를 저장한 뒤 다시 읽으면 값이 유지된다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  a.setNoteFont('n1', { family: 'batang', titlePt: 14, bodyPt: 11 })
  a.save()

  const b = new Store(file)
  b.load()
  assert.deepStrictEqual(b.getNoteFont('n1'), { family: 'batang', titlePt: 14, bodyPt: 11 })
})

test('부분 재정의(글꼴만)도 부분인 채로 살아남는다 — 전역 값이 베껴 들어가지 않는다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  assert.deepStrictEqual(a.setNoteFont('n1', { family: 'gulim' }), { family: 'gulim' })
  a.save()

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepStrictEqual(onDisk.notes.n1.font, { family: 'gulim' },
    '고르지 않은 크기까지 파일에 굳어 버리면 전역 설정을 바꿔도 이 노트만 안 따라온다')

  const b = new Store(file)
  b.load()
  assert.deepStrictEqual(b.getNoteFont('n1'), { family: 'gulim' })
})

test('노트별 서체는 그 노트의 위치/크기/보이기/접힘/보관본과 나란히 산다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  a.setNote('n1', {
    x: 700, y: 300, w: 320, h: 380, visible: true, folded: true,
    conflictBackup: { title: '제목', text: '본문' }
  })
  a.setNoteFont('n1', { bodyPt: 13 })
  a.save()

  const b = new Store(file)
  b.load()
  const n = b.getNote('n1')
  assert.deepStrictEqual([n.x, n.y, n.w, n.h], [700, 300, 320, 380])
  assert.strictEqual(n.visible, true)
  assert.strictEqual(n.folded, true)
  assert.deepStrictEqual(n.conflictBackup, { title: '제목', text: '본문' })
  assert.deepStrictEqual(b.getNoteFont('n1'), { bodyPt: 13 })
})

test('서체를 저장해도 그 노트의 다른 필드를 지우지 않는다', () => {
  const s = new Store(tmpFile())
  s.load()
  s.setNote('n1', { x: 55, visible: true })
  s.setNoteFont('n1', { family: 'consolas' })
  assert.strictEqual(s.getNote('n1').x, 55)
  assert.deepStrictEqual(s.visibleIds(), ['n1'])
})

test('노트별 서체 재정의를 지우면 다시 null 이 된다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  a.setNoteFont('n1', { family: 'batang', titlePt: 20 })
  assert.strictEqual(a.setNoteFont('n1', null), null)
  a.save()

  const b = new Store(file)
  b.load()
  assert.strictEqual(b.getNoteFont('n1'), null)
  assert.strictEqual(b.getNote('n1').font, null)
})

test('말도 안 되는 노트별 서체는 state.json 에 들어가기 전에 걸러진다', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  const saved = a.setNoteFont('n1', { family: 'evil', titlePt: 999, bodyPt: '아무거나' })
  assert.deepStrictEqual(saved, { titlePt: 24 })
  a.save()

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepStrictEqual(onDisk.notes.n1.font, { titlePt: 24 }, '파일에는 검증을 지난 값만 남는다')
})

test('state.json 을 손으로 고쳐 이상한 노트별 서체를 넣어도 화면까지 오지 않는다', () => {
  const file = tmpFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    notes: { n1: { visible: true, font: { family: 'evil', titlePt: -3, bodyPt: 500 } } }
  }), 'utf8')
  const s = new Store(file)
  s.load()
  assert.deepStrictEqual(s.getNoteFont('n1'), { titlePt: 6, bodyPt: 24 })
})

// --- 지운 노트는 상태도 남기지 않는다 -----------------------------------------

test('forgetNote 는 그 노트의 상태를 통째로 지운다 — 보관본까지', () => {
  const file = tmpFile()
  const a = new Store(file)
  a.load()
  a.setNote('n1', { visible: true, conflictBackup: { title: '제목', text: '지운 메모의 본문' } })
  a.setNoteFont('n1', { family: 'batang' })
  a.setNote('n2', { visible: true })
  assert.strictEqual(a.forgetNote('n1'), true)
  a.save()

  const b = new Store(file)
  b.load()
  assert.strictEqual(b.getNote('n1'), null)
  assert.strictEqual(b.getNoteFont('n1'), null)
  assert.deepStrictEqual(b.visibleIds(), ['n2'], '남의 노트는 건드리지 않는다')

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(!Object.prototype.hasOwnProperty.call(onDisk.notes, 'n1'))
  assert.ok(!JSON.stringify(onDisk).includes('지운 메모의 본문'),
    '지운 메모의 본문이 state.json 에 남아 있으면 안 된다')
})

test('forgetNote 는 없는 노트에도 안전하다', () => {
  const s = new Store(tmpFile())
  s.load()
  assert.strictEqual(s.forgetNote('없는id'), false)
  assert.deepStrictEqual(s.visibleIds(), [])
})
