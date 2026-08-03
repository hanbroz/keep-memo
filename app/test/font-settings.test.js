'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  FONT_CHOICES, FONT_PT_RANGE, DEFAULT_FONT_SETTINGS,
  fontStackFor, clampPt, normalizeFontSettings, applyFontSettings
} = require('../renderer/font-settings')

/** document 없이 applyFontSettings 를 시험하기 위한 최소한의 가짜 <html>. */
function fakeRoot () {
  const props = {}
  return { props, style: { setProperty: (k, v) => { props[k] = v } } }
}

// --- 기본값 ----------------------------------------------------------------

test('저장된 것이 없으면 기본값이다 — Noto Sans KR, 제목 10pt, 본문 9pt', () => {
  assert.deepStrictEqual(normalizeFontSettings(null),
    { family: 'noto-sans-kr', titlePt: 10, bodyPt: 9 })
  assert.deepStrictEqual(normalizeFontSettings(undefined), DEFAULT_FONT_SETTINGS)
  assert.deepStrictEqual(normalizeFontSettings({}), DEFAULT_FONT_SETTINGS)
})

test('기본 글꼴은 목록의 첫 항목이고 Noto Sans KR 이다', () => {
  assert.strictEqual(DEFAULT_FONT_SETTINGS.family, FONT_CHOICES[0].key)
  assert.strictEqual(FONT_CHOICES[0].label, 'Noto Sans KR')
})

test('설정 객체가 아닌 것(문자열, 숫자, 배열)이 와도 기본값으로 떨어진다', () => {
  assert.deepStrictEqual(normalizeFontSettings('맑은고딕'), DEFAULT_FONT_SETTINGS)
  assert.deepStrictEqual(normalizeFontSettings(42), DEFAULT_FONT_SETTINGS)
  assert.deepStrictEqual(normalizeFontSettings([]), DEFAULT_FONT_SETTINGS)
})

// --- 글꼴 목록 --------------------------------------------------------------

test('모든 선택지는 일반 계열(generic family)로 끝난다 — 없는 기계에서도 안 깨진다', () => {
  const generic = ['sans-serif', 'serif', 'monospace', 'system-ui', 'cursive', 'fantasy']
  for (const choice of FONT_CHOICES) {
    const last = choice.stack.split(',').pop().trim()
    assert.ok(generic.includes(last), `${choice.key} 의 대체 사슬이 '${last}' 로 끝난다`)
  }
})

test('모든 선택지에 한국어 안전판(Malgun Gothic)이 들어 있다', () => {
  for (const choice of FONT_CHOICES) {
    assert.ok(choice.stack.includes('Malgun Gothic'), `${choice.key} 에 맑은 고딕 대체가 없다`)
  }
})

test('웹폰트를 부르는 선택지는 없다 — 오프라인에서도 떠야 한다', () => {
  for (const choice of FONT_CHOICES) {
    assert.ok(!/url\(|https?:|@import/i.test(choice.stack), `${choice.key} 가 외부를 부른다`)
  }
})

test('key 는 서로 겹치지 않는다', () => {
  const keys = FONT_CHOICES.map((c) => c.key)
  assert.strictEqual(new Set(keys).size, keys.length)
})

test('모르는 글꼴 key 는 기본 글꼴로 떨어진다', () => {
  assert.strictEqual(normalizeFontSettings({ family: '없는글꼴' }).family, DEFAULT_FONT_SETTINGS.family)
  assert.strictEqual(normalizeFontSettings({ family: 123 }).family, DEFAULT_FONT_SETTINGS.family)
  assert.strictEqual(fontStackFor('없는글꼴'), FONT_CHOICES[0].stack)
  assert.strictEqual(fontStackFor(undefined), FONT_CHOICES[0].stack)
})

test('아는 글꼴 key 는 그대로 살아남는다', () => {
  assert.strictEqual(normalizeFontSettings({ family: 'batang' }).family, 'batang')
  assert.strictEqual(fontStackFor('batang'), "'Batang', 'Malgun Gothic', serif")
})

test('사용자가 고르는 것은 key 뿐이고, CSS 문자열은 표에서만 나온다', () => {
  // 사용자가 정한 값이 CSS 로 이어붙여지는 경로가 없다는 것의 증명: 아무 문자열을
  // family 로 넣어도 돌아오는 stack 은 표에 있는 것 중 하나다.
  const stacks = new Set(FONT_CHOICES.map((c) => c.stack))
  const evil = "x, sans-serif; } * { display: none } :root { --x: '"
  const applied = applyFontSettings({ family: evil }, fakeRoot())
  assert.ok(stacks.has(fontStackFor(applied.family)))
  assert.strictEqual(applied.family, DEFAULT_FONT_SETTINGS.family)
})

// --- 크기 -------------------------------------------------------------------

test('말도 안 되는 크기는 범위 안으로 조여진다', () => {
  assert.strictEqual(normalizeFontSettings({ titlePt: 999 }).titlePt, FONT_PT_RANGE.max)
  assert.strictEqual(normalizeFontSettings({ bodyPt: 0 }).bodyPt, FONT_PT_RANGE.min)
  assert.strictEqual(normalizeFontSettings({ bodyPt: -40 }).bodyPt, FONT_PT_RANGE.min)
  assert.strictEqual(clampPt(1000, 9), FONT_PT_RANGE.max)
})

test('숫자로 읽을 수 없는 크기는 기본값으로 떨어진다 — 조이지 않는다', () => {
  assert.strictEqual(normalizeFontSettings({ titlePt: '크게' }).titlePt, DEFAULT_FONT_SETTINGS.titlePt)
  assert.strictEqual(normalizeFontSettings({ bodyPt: null }).bodyPt, DEFAULT_FONT_SETTINGS.bodyPt)
  assert.strictEqual(normalizeFontSettings({ bodyPt: NaN }).bodyPt, DEFAULT_FONT_SETTINGS.bodyPt)
  assert.strictEqual(normalizeFontSettings({ bodyPt: Infinity }).bodyPt, DEFAULT_FONT_SETTINGS.bodyPt)
  assert.strictEqual(normalizeFontSettings({ bodyPt: {} }).bodyPt, DEFAULT_FONT_SETTINGS.bodyPt)
})

test('빈 입력칸은 0pt 가 아니라 기본값이다', () => {
  // Number('') 는 0 이다. 그대로 두면 "안 적었다"가 최소 크기로 둔갑한다.
  assert.strictEqual(normalizeFontSettings({ bodyPt: '' }).bodyPt, DEFAULT_FONT_SETTINGS.bodyPt)
  assert.strictEqual(normalizeFontSettings({ bodyPt: '   ' }).bodyPt, DEFAULT_FONT_SETTINGS.bodyPt)
})

test('입력칸이 주는 문자열 숫자도 받는다', () => {
  assert.strictEqual(normalizeFontSettings({ titlePt: '14' }).titlePt, 14)
  assert.strictEqual(normalizeFontSettings({ bodyPt: '11.4' }).bodyPt, 11)
})

test('범위 안의 값은 그대로 남는다', () => {
  const s = normalizeFontSettings({ family: 'malgun-gothic', titlePt: 12, bodyPt: 10 })
  assert.deepStrictEqual(s, { family: 'malgun-gothic', titlePt: 12, bodyPt: 10 })
})

test('기본값 자체가 허용 범위 안에 있다', () => {
  for (const pt of [DEFAULT_FONT_SETTINGS.titlePt, DEFAULT_FONT_SETTINGS.bodyPt]) {
    assert.ok(pt >= FONT_PT_RANGE.min && pt <= FONT_PT_RANGE.max)
  }
})

// --- 화면에 입히기 ----------------------------------------------------------

test('applyFontSettings 는 CSS 변수 세 개를 pt 단위로 세운다', () => {
  const root = fakeRoot()
  const applied = applyFontSettings({ family: 'malgun-gothic', titlePt: 12, bodyPt: 10 }, root)
  assert.deepStrictEqual(root.props, {
    '--font-ui': "'Malgun Gothic', 'Noto Sans KR', sans-serif",
    '--fs-title': '12pt',
    '--fs-body': '10pt'
  })
  assert.deepStrictEqual(applied, { family: 'malgun-gothic', titlePt: 12, bodyPt: 10 })
})

test('applyFontSettings 는 실제로 입힌(=검증을 지난) 값을 돌려준다', () => {
  const root = fakeRoot()
  const applied = applyFontSettings({ family: '없는글꼴', titlePt: 999, bodyPt: 'x' }, root)
  assert.deepStrictEqual(applied,
    { family: DEFAULT_FONT_SETTINGS.family, titlePt: FONT_PT_RANGE.max, bodyPt: DEFAULT_FONT_SETTINGS.bodyPt })
  assert.strictEqual(root.props['--fs-title'], `${FONT_PT_RANGE.max}pt`)
})

test('입힐 곳이 없어도(문서 없는 곳) 던지지 않는다', () => {
  assert.deepStrictEqual(applyFontSettings(null, null), DEFAULT_FONT_SETTINGS)
  assert.deepStrictEqual(applyFontSettings({}, {}), DEFAULT_FONT_SETTINGS)
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof normalizeFontSettings, 'function')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
