'use strict'

// 새 버전이 GitHub 릴리즈에 올라왔는지 판단하는 **순수 함수들**.
//
// 네트워크도 파일시스템도 Electron 도 건드리지 않는다 — version-notice.js 와
// 같은 관례다. 실제로 받아오고 내려받고 재실행하는 일은 main.js 가 하고, 여기서는
// "받아온 JSON 을 보고 업데이트해야 하는가, 무엇을 받아야 하는가"만 정한다.
// 그래야 Electron 을 띄우지 않고, 진짜 릴리즈를 만들지 않고도 판단을 검사할 수
// 있다.
//
// **왜 electron-updater 가 아닌가**: 이 앱은 portable 타겟이다. 그것은 설치
// 프로그램이 아니라 자기 자신을 %TEMP% 에 풀고 실행하는 자체 압축 해제
// 아카이브이고(app-builder-lib 의 portable.nsi), electron-updater 의 윈도우
// 경로는 NSIS **설치본**을 받아 실행하는 방식이라 설치할 곳이 없는 포터블에는
// 쓸 수 없다. 대신 이 앱에는 이미 필요한 조각이 다 있다 — 원본 exe 경로를 아는
// PORTABLE_EXECUTABLE_FILE 처리와, app.relaunch({ execPath }) 로 **다른** exe 를
// 띄우는 절차(version-notice.js 의 재실행 경로)다. 여기서는 그 앞에 "무엇을
// 받을지" 한 조각만 더한다.

// 빌드 스탬프의 자리 수. scripts/build.js 의 fullStamp("yyyy.MM.dd.HH.mm")와
// 같은 모양이어야 한다.
const STAMP_PARTS = 5

/**
 * "yyyy.MM.dd.HH.mm" 을 숫자 다섯 개로 쪼갠다. 모양이 아니면 null.
 *
 * **문자열 비교로 때우지 않는 이유**: 지금은 build.js 가 두 자리로 0을 채워
 * 사전순이 곧 시간순이지만, 그 규칙이 한 번이라도 흔들리면(예: 1월이 "1"로
 * 나가면) 문자열 비교는 조용히 틀린 답을 낸다. 조용히 틀리는 것이 최악이다 —
 * 새 버전이 있는데 없다고 하거나, 옛 버전으로 "업데이트" 한다.
 *
 * @param {unknown} text
 * @returns {number[] | null}
 */
function parseBuildStamp (text) {
  if (typeof text !== 'string') return null
  const parts = text.trim().split('.')
  if (parts.length !== STAMP_PARTS) return null
  const nums = []
  for (const part of parts) {
    // 정규식으로 먼저 거른다. Number('') 는 0 이고 Number(' 12 ') 도 12 라,
    // parseInt/Number 만 믿으면 빈 칸과 공백이 조용히 통과한다.
    if (!/^\d{1,4}$/.test(part)) return null
    nums.push(Number(part))
  }
  return nums
}

/**
 * 두 스탬프를 비교한다. a 가 더 새것이면 1, 같으면 0, 더 옛것이면 -1.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function compareBuildStamps (a, b) {
  for (let i = 0; i < STAMP_PARTS; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  }
  return 0
}

/**
 * 릴리즈 태그에서 스탬프 문자열을 뽑는다. "v2026.08.05.10.19" → "2026.08.05.10.19".
 *
 * 앞의 v 는 관례일 뿐이라 있어도 없어도 받는다.
 *
 * @param {unknown} tag
 * @returns {string | null}
 */
function stampFromTag (tag) {
  if (typeof tag !== 'string') return null
  const text = tag.trim().replace(/^v/i, '')
  return parseBuildStamp(text) === null ? null : text
}

/**
 * 릴리즈에 딸린 파일 중 이 앱의 포터블 exe 를 고른다.
 *
 * 이름으로 고른다("KeepSticky-" 로 시작하고 ".exe" 로 끝난다). 릴리즈에 나중에
 * 다른 파일(체크섬, 설치본, 소스 zip)이 붙어도 엉뚱한 것을 내려받지 않게 하는
 * 것이 목적이다 — 첫 번째 파일을 그냥 집으면 언젠가 그렇게 된다.
 *
 * @param {unknown} assets
 * @returns {{name: string, url: string, size: number} | null}
 */
function pickPortableAsset (assets) {
  if (!Array.isArray(assets)) return null
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue
    const name = typeof asset.name === 'string' ? asset.name : ''
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
    if (!/^KeepSticky-.+\.exe$/i.test(name)) continue
    if (!/^https:\/\//i.test(url)) continue
    return { name, url, size: Number.isFinite(asset.size) ? asset.size : 0 }
  }
  return null
}

/**
 * 지금 버전과 받아온 릴리즈를 견주어 무엇을 할지 정한다.
 *
 * **currentStamp 를 모르면 아무것도 하지 않는다.** 개발 중 실행(npm start)에는
 * 빌드 스탬프가 없는데, 그때 "모르니까 일단 받자"로 굴면 개발자가 고치던 코드를
 * 릴리즈본이 덮어쓴다. 모를 때는 가만히 있는 쪽이 언제나 옳다.
 *
 * reason 을 같이 돌려주는 이유: 사용자가 트레이에서 직접 [업데이트 확인] 을
 * 눌렀을 때 "왜 아무 일도 없는지"를 말해 줘야 한다. 아무 일도 일어나지 않는
 * 것이 이 앱에서 가장 나쁜 응답이다.
 *
 * @param {unknown} currentStamp - 지금 실행 중인 빌드의 "yyyy.MM.dd.HH.mm"
 * @param {unknown} release - GitHub 의 릴리즈 JSON 하나
 * @returns {{action: 'none', reason: string}
 *          | {action: 'update', version: string, name: string, url: string, size: number}}
 */
function decideUpdate (currentStamp, release) {
  const current = parseBuildStamp(currentStamp)
  if (current === null) {
    return { action: 'none', reason: '개발 중 실행이라 업데이트를 확인하지 않습니다.' }
  }
  if (!release || typeof release !== 'object') {
    return { action: 'none', reason: '릴리즈 정보를 읽지 못했습니다.' }
  }
  if (release.draft === true || release.prerelease === true) {
    return { action: 'none', reason: '아직 정식으로 공개된 릴리즈가 아닙니다.' }
  }

  const latestText = stampFromTag(release.tag_name)
  if (latestText === null) {
    return { action: 'none', reason: `릴리즈 태그를 읽지 못했습니다: ${release.tag_name}` }
  }
  const latest = parseBuildStamp(latestText)
  if (compareBuildStamps(latest, current) <= 0) {
    return { action: 'none', reason: '이미 최신 버전입니다.' }
  }

  const asset = pickPortableAsset(release.assets)
  if (asset === null) {
    // 태그는 새것인데 받을 파일이 없다. 조용히 넘어가면 사용자는 영영 새 버전을
    // 못 받는다 — 릴리즈를 올린 사람이 파일을 빠뜨렸다는 뜻이므로 말해 준다.
    return { action: 'none', reason: `새 버전 ${latestText} 이 있지만 받을 exe 가 릴리즈에 없습니다.` }
  }
  return { action: 'update', version: latestText, name: asset.name, url: asset.url, size: asset.size }
}

module.exports = {
  parseBuildStamp,
  compareBuildStamps,
  stampFromTag,
  pickPortableAsset,
  decideUpdate,
  STAMP_PARTS
}
