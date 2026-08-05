'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  parseBuildStamp, compareBuildStamps, stampFromTag, pickPortableAsset, decideUpdate
} = require('../update-check')

// 이 파일이 지키는 것: "새 버전이 있는가"를 조용히 틀리지 않는 것. 틀리는 방향이
// 둘 다 나쁘다 — 새 버전이 있는데 없다고 하면 사용자는 영영 못 받고, 옛 버전을
// 새것이라 하면 방금 고친 것이 되돌아간다.

const release = (over = {}) => ({
  tag_name: 'v2026.08.05.10.19',
  draft: false,
  prerelease: false,
  assets: [{
    name: 'KeepSticky-2026.08.05.10.19.exe',
    browser_download_url: 'https://github.com/hanbroz/keep-memo/releases/download/x/KeepSticky-2026.08.05.10.19.exe',
    size: 91851348
  }],
  ...over
})

// --- 스탬프 읽기 -------------------------------------------------------------

test('yyyy.MM.dd.HH.mm 을 숫자 다섯으로 쪼갠다', () => {
  assert.deepStrictEqual(parseBuildStamp('2026.08.05.10.19'), [2026, 8, 5, 10, 19])
})

test('모양이 아니면 null 이다', () => {
  for (const bad of ['2026.08.05.10', '2026.08.05.10.19.30', '', '  ', 'v2026.08.05.10.19',
                     '2026-08-05-10-19', '2026.08.05.10.ab', '2026..05.10.19', null, 42, {}]) {
    assert.strictEqual(parseBuildStamp(bad), null, JSON.stringify(bad))
  }
})

test('빈 칸과 공백이 0 으로 조용히 통과하지 않는다', () => {
  // Number('') 는 0, Number(' 1 ') 은 1 이다. 정규식으로 먼저 거르지 않으면
  // "2026...19" 같은 것이 유효한 스탬프가 된다.
  assert.strictEqual(parseBuildStamp('2026. .05.10.19'), null)
  assert.strictEqual(parseBuildStamp('2026.08.05.10. '), null)
})

// --- 비교 -------------------------------------------------------------------

test('자리별로 비교한다 — 사전순이 아니다', () => {
  const a = parseBuildStamp('2026.08.05.10.19')
  assert.strictEqual(compareBuildStamps(a, parseBuildStamp('2026.08.05.10.18')), 1)
  assert.strictEqual(compareBuildStamps(a, parseBuildStamp('2026.08.05.10.19')), 0)
  assert.strictEqual(compareBuildStamps(a, parseBuildStamp('2026.08.05.11.00')), -1)
})

test('0 을 안 채운 스탬프끼리도 시간순으로 비교된다', () => {
  // 사전순이었다면 '2026.9.1.0.0' < '2026.10.1.0.0' 이 거짓이 된다("9" > "1").
  const sep = parseBuildStamp('2026.9.1.0.0')
  const oct = parseBuildStamp('2026.10.1.0.0')
  assert.strictEqual(compareBuildStamps(oct, sep), 1, '10월이 9월보다 나중이다')
})

test('해가 바뀌는 경계', () => {
  assert.strictEqual(
    compareBuildStamps(parseBuildStamp('2027.01.01.00.00'), parseBuildStamp('2026.12.31.23.59')), 1)
})

// --- 태그 -------------------------------------------------------------------

test('태그 앞의 v 는 있어도 없어도 된다', () => {
  assert.strictEqual(stampFromTag('v2026.08.05.10.19'), '2026.08.05.10.19')
  assert.strictEqual(stampFromTag('2026.08.05.10.19'), '2026.08.05.10.19')
  assert.strictEqual(stampFromTag('  v2026.08.05.10.19  '), '2026.08.05.10.19')
})

test('스탬프 모양이 아닌 태그는 null 이다', () => {
  for (const bad of ['v1.0.0', 'latest', '', null, 'release-2026']) {
    assert.strictEqual(stampFromTag(bad), null, JSON.stringify(bad))
  }
})

// --- 받을 파일 고르기 ---------------------------------------------------------

test('KeepSticky-*.exe 를 고른다', () => {
  const asset = pickPortableAsset(release().assets)
  assert.strictEqual(asset.name, 'KeepSticky-2026.08.05.10.19.exe')
  assert.strictEqual(asset.size, 91851348)
})

test('첫 번째 파일을 그냥 집지 않는다', () => {
  // 릴리즈에 체크섬이나 소스 zip 이 먼저 붙어 있어도 exe 를 찾아야 한다.
  const assets = [
    { name: 'SHA256SUMS.txt', browser_download_url: 'https://x/SHA256SUMS.txt', size: 100 },
    { name: 'KeepSticky-2026.08.05.10.19.exe', browser_download_url: 'https://x/a.exe', size: 9 }
  ]
  assert.strictEqual(pickPortableAsset(assets).name, 'KeepSticky-2026.08.05.10.19.exe')
})

test('https 가 아닌 주소는 받지 않는다', () => {
  const assets = [{ name: 'KeepSticky-x.exe', browser_download_url: 'http://x/a.exe', size: 1 }]
  assert.strictEqual(pickPortableAsset(assets), null)
})

test('exe 가 없으면 null 이다', () => {
  assert.strictEqual(pickPortableAsset([{ name: 'notes.txt', browser_download_url: 'https://x/n.txt' }]), null)
  assert.strictEqual(pickPortableAsset([]), null)
  assert.strictEqual(pickPortableAsset(null), null)
})

// --- 판단 -------------------------------------------------------------------

test('더 새 버전이 있으면 받을 것을 알려준다', () => {
  const res = decideUpdate('2026.08.05.09.00', release())
  assert.strictEqual(res.action, 'update')
  assert.strictEqual(res.version, '2026.08.05.10.19')
  assert.match(res.url, /^https:\/\//)
})

test('같은 버전이면 아무것도 하지 않는다', () => {
  const res = decideUpdate('2026.08.05.10.19', release())
  assert.strictEqual(res.action, 'none')
  assert.match(res.reason, /최신/)
})

test('릴리즈가 더 옛것이면 되돌아가지 않는다', () => {
  // 누군가 옛 태그를 latest 로 만들었을 때 방금 고친 것이 사라지면 안 된다.
  const res = decideUpdate('2026.08.05.10.19', release({ tag_name: 'v2026.08.01.09.00' }))
  assert.strictEqual(res.action, 'none')
})

test('개발 중 실행(스탬프 없음)에서는 절대 업데이트하지 않는다', () => {
  // npm start 에는 빌드 스탬프가 없다. "모르니까 받자"로 굴면 개발자가 고치던
  // 코드를 릴리즈본이 덮어쓴다.
  for (const missing of [undefined, null, '', '0.1.0']) {
    const res = decideUpdate(missing, release())
    assert.strictEqual(res.action, 'none', JSON.stringify(missing))
    assert.match(res.reason, /개발/)
  }
})

test('초안과 시험판은 건너뛴다', () => {
  assert.strictEqual(decideUpdate('2026.01.01.00.00', release({ draft: true })).action, 'none')
  assert.strictEqual(decideUpdate('2026.01.01.00.00', release({ prerelease: true })).action, 'none')
})

test('태그가 새것인데 exe 가 없으면 이유를 말해 준다', () => {
  // 조용히 넘어가면 사용자는 영영 새 버전을 못 받는다.
  const res = decideUpdate('2026.08.01.00.00', release({ assets: [] }))
  assert.strictEqual(res.action, 'none')
  assert.match(res.reason, /2026\.08\.05\.10\.19/)
  assert.match(res.reason, /exe/)
})

test('릴리즈가 통째로 이상해도 던지지 않는다', () => {
  for (const bad of [null, undefined, 42, 'latest', {}, { tag_name: 'nope' }]) {
    const res = decideUpdate('2026.08.05.10.19', bad)
    assert.strictEqual(res.action, 'none', JSON.stringify(bad))
    assert.ok(res.reason.length > 0, '이유는 항상 있어야 한다')
  }
})

test('Electron 없이도 require 된다', () => {
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
