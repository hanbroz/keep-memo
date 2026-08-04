'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// 렌더러의 <script src> 들은 **하나의 전역 스코프를 공유한다.**
//
// contextIsolation 이 켜진 렌더러에는 require 가 없어서, 이 앱의 순수 로직
// 모듈들은 클래식 <script> 로 나란히 실려 최상위 선언을 서로에게 넘겨준다
// (note-font.js 의 긴 주석이 설명하는 그 구조다). 그 대가로 이름이 겹치면:
//
//   - const / let / class 가 겹치면 **그 자리에서 SyntaxError** 다. 뒤에 오는
//     스크립트가 통째로 실행되지 않아 창이 반쯤 죽은 채로 뜬다.
//   - function 이 겹치면 에러 없이 나중 것이 이긴다. 더 나쁘다 — 한쪽만 고친
//     날 다른 쪽이 소리 없이 따라 바뀐다.
//
// 어느 쪽도 테스트 없이는 눈에 띄지 않는다. 창을 띄우지 않고 잡을 수 있는
// 검사이므로 여기서 잡는다.

const RENDERER = path.join(__dirname, '..', 'renderer')

/**
 * HTML 에서 <script src="..."> 를 나온 순서대로 뽑는다.
 *
 * 주석을 먼저 걷어내는 것이 중요하다 — note.html 의 <style> 안 주석에 이 구조를
 * 설명하며 `<script src="font-settings.js">` 라고 적힌 줄이 실제로 있다. 그것까지
 * 세면 같은 파일을 두 번 싣는 것으로 읽혀 모든 이름이 자기 자신과 겹친다.
 */
function scriptSources (htmlFile) {
  const html = fs.readFileSync(path.join(RENDERER, htmlFile), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  return [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1])
}

/** 파일 최상위(들여쓰기 없음)의 선언 이름을 뽑는다. */
function topLevelDeclarations (file) {
  const src = fs.readFileSync(path.join(RENDERER, file), 'utf8')
  const out = []
  for (const m of src.matchAll(/^(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    out.push({ kind: m[1], name: m[2] })
  }
  return out
}

for (const htmlFile of ['note.html', 'list.html', 'setup-email.html']) {
  test(`${htmlFile}: 함께 실리는 스크립트들의 최상위 이름이 겹치지 않는다`, () => {
    const owners = new Map() // name -> { file, kind }
    const clashes = []
    for (const src of scriptSources(htmlFile)) {
      if (!fs.existsSync(path.join(RENDERER, src))) {
        // <script src> 가 가리키는 파일이 없으면 그것부터가 버그다.
        assert.fail(`${htmlFile} 이 부르는 ${src} 가 없다`)
      }
      for (const decl of topLevelDeclarations(src)) {
        const prev = owners.get(decl.name)
        if (prev) {
          clashes.push(`${decl.name} (${prev.file} ${prev.kind} ↔ ${src} ${decl.kind})`)
          continue
        }
        owners.set(decl.name, { file: src, kind: decl.kind })
      }
    }
    assert.deepStrictEqual(clashes, [],
      `같은 창에 실리는 스크립트끼리 최상위 이름이 겹친다:\n  ${clashes.join('\n  ')}`)
  })
}

test('note.html 은 note.js 보다 먼저 순수 로직 모듈들을 부른다', () => {
  // note.js 는 require() 없이 이 전역들을 그대로 쓴다. 순서가 뒤집히면
  // ReferenceError 로 창이 죽는다.
  const sources = scriptSources('note.html')
  const noteIndex = sources.indexOf('note.js')
  assert.ok(noteIndex >= 0, 'note.html 이 note.js 를 불러야 한다')
  for (const dep of ['bookmark-text.js', 'line-model.js', 'undo-stack.js',
                     'checklist-items.js', 'url-open.js',
                     'font-settings.js', 'note-font.js']) {
    const at = sources.indexOf(dep)
    assert.ok(at >= 0, `note.html 이 ${dep} 를 불러야 한다`)
    assert.ok(at < noteIndex, `${dep} 는 note.js 보다 먼저여야 한다`)
  }
  // note-font.js 는 font-settings.js 의 선언을 쓴다.
  assert.ok(sources.indexOf('font-settings.js') < sources.indexOf('note-font.js'),
    'font-settings.js 는 note-font.js 보다 먼저여야 한다')
})

test('세 창의 :root 블록이 갈라지지 않았다', () => {
  // list / note / setup-email 의 :root 는 항상 같이 고쳐야 하는 세 벌이다.
  // 실제로 화면에 남는 값은 applyFontSettings() 가 덮어쓰지만, 그 함수가 돌기
  // 전까지의 첫 그림이 창마다 다르면 뜨는 순간 깜박인다.
  const read = (file) => {
    const html = fs.readFileSync(path.join(RENDERER, file), 'utf8')
    const m = html.match(/:root\s*\{([\s\S]*?)\}/)
    assert.ok(m, `${file} 에 :root 블록이 있어야 한다`)
    // 세 벌이 공통으로 들고 있는 토큰만 견준다(창마다 자기만의 토큰이 더 있다).
    const shared = {}
    for (const decl of m[1].split(';')) {
      const kv = decl.match(/(--font-ui|--fs-xs|--fs-sm|--fs-md|--fs-lg|--fs-title|--fs-body|--lh-tight)\s*:\s*([^;]+)/)
      if (kv) shared[kv[1]] = kv[2].trim()
    }
    return shared
  }
  const base = read('list.html')
  assert.ok(Object.keys(base).length >= 8, '공통 토큰을 찾지 못했다')
  assert.deepStrictEqual(read('note.html'), base, 'note.html 의 :root 가 list.html 과 다르다')
  assert.deepStrictEqual(read('setup-email.html'), base,
    'setup-email.html 의 :root 가 list.html 과 다르다')
})

test('포스트잇과 목록의 Keep 팔레트가 갈라지지 않았다', () => {
  // 목록 행의 배경색은 그 메모를 띄웠을 때의 포스트잇 색과 **같아야** 한다.
  // 그런데 CSP 가 style-src 'unsafe-inline' 뿐이라 팔레트를 별도 .css 로 빼
  // <link> 로 나눠 쓸 수가 없고, 두 창이 같은 12개 hex 를 각자 적고 있다.
  // 한쪽만 고친 날을 잡는 검사다.
  const palette = (file) => {
    const html = fs.readFileSync(path.join(RENDERER, file), 'utf8')
    const m = html.match(/:root\s*\{([\s\S]*?)\}/)
    assert.ok(m, `${file} 에 :root 블록이 있어야 한다`)
    const out = {}
    for (const kv of m[1].matchAll(/(--c-[a-z]+)\s*:\s*([^;]+)/g)) out[kv[1]] = kv[2].trim()
    return out
  }
  const base = palette('note.html')
  assert.strictEqual(Object.keys(base).length, 12, 'note.html 의 Keep 팔레트는 12색이다')
  assert.deepStrictEqual(palette('list.html'), base,
    'list.html 의 Keep 팔레트가 note.html 과 다르다')

  // 값만 같고 규칙이 없으면 목록은 여전히 흰 바탕이다. 12색 전부에 행 규칙이
  // 있는지까지 본다 — 열두 줄 중 하나를 빠뜨리는 것이 실제로 있을 법한 실수다.
  const listCss = fs.readFileSync(path.join(RENDERER, 'list.html'), 'utf8')
  for (const name of ['White', 'Red', 'Orange', 'Yellow', 'Green', 'Teal',
                      'Blue', 'DarkBlue', 'Purple', 'Pink', 'Brown', 'Gray']) {
    assert.match(listCss, new RegExp(`li\\[data-color="${name}"\\]`),
      `list.html 에 ${name} 행 배경 규칙이 없다`)
  }
})
