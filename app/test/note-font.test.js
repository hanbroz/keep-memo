'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { normalizeNoteFontOverride, resolveNoteFont } = require('../renderer/note-font')
const {
  FONT_CHOICES, FONT_PT_RANGE, DEFAULT_FONT_SETTINGS
} = require('../renderer/font-settings')

// 이 테스트가 지키는 것은 하나다: **재정의는 사용자가 실제로 고른 항목만
// 담고, 나머지는 그때그때 전역 설정에서 온다.** 전역 값을 노트 쪽에 복사해
// 두는 순간 "전역을 바꿔도 이 노트만 안 바뀐다"가 시작된다.

const GLOBAL = { family: 'malgun-gothic', titlePt: 12, bodyPt: 10 }

// --- 재정의가 없으면 전역을 따른다 -------------------------------------------

test('재정의가 없으면 전역 설정 그대로다', () => {
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, null), GLOBAL)
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, undefined), GLOBAL)
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, {}), GLOBAL)
})

test('재정의가 객체가 아니면(문자열, 숫자, 배열) 전역을 따른다', () => {
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, '바탕'), GLOBAL)
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, 14), GLOBAL)
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, []), GLOBAL)
})

test('전역 설정이 없거나 이상해도 던지지 않고 전역 기본값으로 떨어진다', () => {
  assert.deepStrictEqual(resolveNoteFont(null, null), DEFAULT_FONT_SETTINGS)
  assert.deepStrictEqual(resolveNoteFont('아무거나', null), DEFAULT_FONT_SETTINGS)
  assert.deepStrictEqual(resolveNoteFont({ family: '없는글꼴', titlePt: 999 }, null),
    { family: DEFAULT_FONT_SETTINGS.family, titlePt: FONT_PT_RANGE.max, bodyPt: DEFAULT_FONT_SETTINGS.bodyPt })
})

// --- 부분 재정의가 제대로 합쳐진다 -------------------------------------------

test('글꼴만 재정의하면 크기는 전역 그대로다', () => {
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, { family: 'batang' }),
    { family: 'batang', titlePt: GLOBAL.titlePt, bodyPt: GLOBAL.bodyPt })
})

test('본문 크기만 재정의하면 글꼴과 제목 크기는 전역 그대로다', () => {
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, { bodyPt: 18 }),
    { family: GLOBAL.family, titlePt: GLOBAL.titlePt, bodyPt: 18 })
})

test('제목 크기만 재정의하면 글꼴과 본문 크기는 전역 그대로다', () => {
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, { titlePt: 20 }),
    { family: GLOBAL.family, titlePt: 20, bodyPt: GLOBAL.bodyPt })
})

test('셋 다 재정의하면 전역이 하나도 남지 않는다', () => {
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, { family: 'consolas', titlePt: 7, bodyPt: 8 }),
    { family: 'consolas', titlePt: 7, bodyPt: 8 })
})

// --- 재정의가 없는 항목은 전역을 실시간으로 따라간다 --------------------------

test('전역이 바뀌면 재정의가 없는 항목만 따라 바뀐다', () => {
  const override = { family: 'batang' } // 글꼴만 이 노트 것
  const before = resolveNoteFont({ family: 'malgun-gothic', titlePt: 10, bodyPt: 9 }, override)
  const after = resolveNoteFont({ family: 'consolas', titlePt: 16, bodyPt: 14 }, override)
  assert.deepStrictEqual(before, { family: 'batang', titlePt: 10, bodyPt: 9 })
  assert.deepStrictEqual(after, { family: 'batang', titlePt: 16, bodyPt: 14 },
    '재정의한 글꼴은 그대로, 재정의 안 한 크기는 새 전역값으로')
})

test('재정의가 아예 없는 노트는 전역을 통째로 따라간다', () => {
  const a = { family: 'malgun-gothic', titlePt: 10, bodyPt: 9 }
  const b = { family: 'gulim', titlePt: 22, bodyPt: 20 }
  assert.deepStrictEqual(resolveNoteFont(a, null), a)
  assert.deepStrictEqual(resolveNoteFont(b, null), b)
})

// --- 값 검증은 전역 설정과 같은 잣대다 ---------------------------------------

test('범위를 벗어난 재정의 크기는 조여진다', () => {
  assert.strictEqual(resolveNoteFont(GLOBAL, { titlePt: 999 }).titlePt, FONT_PT_RANGE.max)
  assert.strictEqual(resolveNoteFont(GLOBAL, { bodyPt: -40 }).bodyPt, FONT_PT_RANGE.min)
  assert.strictEqual(resolveNoteFont(GLOBAL, { bodyPt: 0 }).bodyPt, FONT_PT_RANGE.min)
})

test('숫자로 읽을 수 없는 재정의 크기는 재정의가 아니다 — 전역으로 떨어진다', () => {
  // 조이지 않는다. 6pt 로 조여 버리면 "빈 칸"이 최소 크기 재정의로 둔갑한다.
  assert.strictEqual(resolveNoteFont(GLOBAL, { bodyPt: '' }).bodyPt, GLOBAL.bodyPt)
  assert.strictEqual(resolveNoteFont(GLOBAL, { bodyPt: '   ' }).bodyPt, GLOBAL.bodyPt)
  assert.strictEqual(resolveNoteFont(GLOBAL, { bodyPt: null }).bodyPt, GLOBAL.bodyPt)
  assert.strictEqual(resolveNoteFont(GLOBAL, { bodyPt: '크게' }).bodyPt, GLOBAL.bodyPt)
  assert.strictEqual(resolveNoteFont(GLOBAL, { titlePt: NaN }).titlePt, GLOBAL.titlePt)
  assert.strictEqual(resolveNoteFont(GLOBAL, { titlePt: Infinity }).titlePt, GLOBAL.titlePt)
})

test('입력칸이 주는 문자열 숫자도 재정의로 받는다', () => {
  assert.strictEqual(resolveNoteFont(GLOBAL, { titlePt: '14' }).titlePt, 14)
  assert.strictEqual(resolveNoteFont(GLOBAL, { bodyPt: '11.4' }).bodyPt, 11)
})

test('모르는 글꼴 key 는 재정의가 아니다 — 전역 글꼴로 떨어진다', () => {
  assert.strictEqual(resolveNoteFont(GLOBAL, { family: '없는글꼴' }).family, GLOBAL.family)
  assert.strictEqual(resolveNoteFont(GLOBAL, { family: '' }).family, GLOBAL.family)
  assert.strictEqual(resolveNoteFont(GLOBAL, { family: 123 }).family, GLOBAL.family)
})

test('고를 수 있는 글꼴은 전역 설정과 같은 표에서만 나온다', () => {
  // 사용자가 정한 문자열이 CSS 로 이어붙여지는 경로가 없다는 것의 증명.
  const evil = "x, sans-serif; } * { display: none } :root { --x: '"
  assert.strictEqual(resolveNoteFont(GLOBAL, { family: evil }).family, GLOBAL.family)
  for (const choice of FONT_CHOICES) {
    assert.strictEqual(resolveNoteFont(GLOBAL, { family: choice.key }).family, choice.key)
  }
})

// --- 저장될 모양 --------------------------------------------------------------

test('고른 것이 하나도 없으면 재정의는 null 이다', () => {
  assert.strictEqual(normalizeNoteFontOverride(null), null)
  assert.strictEqual(normalizeNoteFontOverride({}), null)
  assert.strictEqual(normalizeNoteFontOverride({ family: '', titlePt: '', bodyPt: '' }), null)
  assert.strictEqual(normalizeNoteFontOverride({ family: '없는글꼴', titlePt: '아무거나' }), null)
  assert.strictEqual(normalizeNoteFontOverride('문자열'), null)
})

test('고른 항목만 남는다 — 전역 값을 베껴 넣지 않는다', () => {
  assert.deepStrictEqual(normalizeNoteFontOverride({ family: 'batang' }), { family: 'batang' })
  assert.deepStrictEqual(normalizeNoteFontOverride({ bodyPt: 11 }), { bodyPt: 11 })
  assert.deepStrictEqual(normalizeNoteFontOverride({ family: 'gulim', titlePt: '13' }),
    { family: 'gulim', titlePt: 13 })
})

test('저장되는 값은 이미 검증을 지난 값이다', () => {
  assert.deepStrictEqual(normalizeNoteFontOverride({ titlePt: 999, bodyPt: -1 }),
    { titlePt: FONT_PT_RANGE.max, bodyPt: FONT_PT_RANGE.min })
})

test('모르는 키는 재정의에 섞여 들어가지 않는다', () => {
  assert.deepStrictEqual(normalizeNoteFontOverride({ family: 'batang', color: 'Red', evil: 1 }),
    { family: 'batang' })
})

test('재정의를 지우면(null) 전역으로 돌아온다', () => {
  const chosen = normalizeNoteFontOverride({ family: 'consolas', titlePt: 20, bodyPt: 18 })
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, chosen),
    { family: 'consolas', titlePt: 20, bodyPt: 18 })
  const cleared = normalizeNoteFontOverride(null)
  assert.strictEqual(cleared, null)
  assert.deepStrictEqual(resolveNoteFont(GLOBAL, cleared), GLOBAL)
})

test('정규화는 멱등하다 — 저장했던 값을 다시 넣어도 같은 값이다', () => {
  const once = normalizeNoteFontOverride({ family: 'batang', titlePt: 999 })
  assert.deepStrictEqual(normalizeNoteFontOverride(once), once)
})

test('resolveNoteFont 의 결과는 applyFontSettings 에 그대로 넘길 수 있는 모양이다', () => {
  const resolved = resolveNoteFont(GLOBAL, { family: 'batang' })
  assert.deepStrictEqual(Object.keys(resolved).sort(), ['bodyPt', 'family', 'titlePt'])
  assert.strictEqual(typeof resolved.family, 'string')
  assert.strictEqual(typeof resolved.titlePt, 'number')
  assert.strictEqual(typeof resolved.bodyPt, 'number')
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof resolveNoteFont, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})

test('렌더러처럼 <script src> 두 장으로 불러도 동작한다 — require 없이', () => {
  // note-font.js 는 이 앱에서 **다른 렌더러 모듈에 기대는 첫 모듈**이다.
  // note.html 은 font-settings.js 를 먼저, note-font.js 를 그다음에 부르고
  // 그 사이에는 require 가 없다 — 클래식 스크립트끼리는 전역 렉시컬 스코프를
  // 공유하므로 앞 스크립트의 최상위 const 를 이름 그대로 쓸 수 있다는 사실에
  // 기대고 있다. 그 가정이 깨지면(예: 누가 두 파일의 순서를 바꾸거나
  // globalThis 로 고쳐 쓰면) 포스트잇 창에서만 조용히 죽고 위의 require 기반
  // 테스트는 전부 통과한다. 그래서 여기서 그 경로를 그대로 흉내 낸다.
  //
  // vm 컨텍스트에는 module 도 require 도 없다 — 렌더러(contextIsolation)와 같다.
  const ctx = vm.createContext({})
  for (const file of ['font-settings.js', 'note-font.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', file), 'utf8')
    new vm.Script(src, { filename: file }).runInContext(ctx)
  }
  assert.strictEqual(vm.runInContext('typeof module', ctx), 'undefined')
  assert.strictEqual(vm.runInContext('typeof resolveNoteFont', ctx), 'function')
  // 결과를 JSON 문자열로 받아 온다. vm 컨텍스트의 객체는 다른 realm 의
  // Object.prototype 을 물고 있어서 deepStrictEqual 이 값과 무관하게 실패한다.
  assert.deepStrictEqual(
    JSON.parse(vm.runInContext('JSON.stringify(resolveNoteFont('
      + '{ family: "malgun-gothic", titlePt: 12, bodyPt: 10 },'
      + ' { family: "batang", titlePt: 999 }))', ctx)),
    { family: 'batang', titlePt: FONT_PT_RANGE.max, bodyPt: 10 })
  // note.js 가 실제로 쓰는 나머지 하나도 같은 방식으로 걸려 있어야 한다.
  assert.strictEqual(vm.runInContext('typeof normalizeNoteFontOverride', ctx), 'function')
  assert.strictEqual(vm.runInContext('typeof applyFontSettings', ctx), 'function')
})
