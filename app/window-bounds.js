'use strict'

// 저장해 둔 창 자리를 **지금의** 화면 구성에 맞추는 순수 함수.
//
// Electron 을 건드리지 않는다 — 화면 목록을 인자로 받으므로 모니터를 실제로
// 뽑았다 꽂았다 하지 않고도 시험할 수 있다. main.js 가 screen().getAllDisplays()
// 의 workArea 들을 넘긴다(작업 표시줄을 뺀 영역이라 창이 그 아래로 숨지 않는다).

// 창이 화면에 이만큼은 걸쳐 있어야 "잡을 수 있다"고 본다. 제목 표시줄을 마우스로
// 붙들 수 있는 최소한이다.
const MIN_VISIBLE = 80

function finite (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 두 사각형이 겹치는 부분. 안 겹치면 null. */
function overlap (a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return (w > 0 && h > 0) ? { w, h } : null
}

/**
 * 저장된 자리를 그대로 쓸지, 화면 안으로 데려올지 정한다.
 *
 * **모니터를 뽑으면 저장된 좌표가 아무 화면에도 없는 자리를 가리킨다.** 그대로
 * 쓰면 창은 열리지만 보이지 않고, 보이지 않으니 끌어올 수도 없다 — 사용자에게는
 * "앱이 안 뜬다"로 보인다. 자리를 기억하는 기능에는 이 구조가 반드시 딸려야 한다.
 *
 * 충분히 걸쳐 있으면 저장된 값을 **그대로** 돌려준다. 두 모니터에 걸쳐 놓은
 * 창을 억지로 한쪽으로 밀어 넣지 않기 위해서다.
 *
 * @param {unknown} saved 저장된 { x, y, width, height } (일부만 있거나 망가져도 된다)
 * @param {Array<{x:number,y:number,width:number,height:number}>} workAreas 화면들의 작업 영역
 * @param {{width:number, height:number, minWidth?:number, minHeight?:number}} fallback 기본 크기
 * @returns {{x?:number, y?:number, width:number, height:number}}
 *   x/y 가 없으면 "정한 자리 없음"이고, BrowserWindow 가 알아서 가운데 띄운다.
 */
function fitWindowBounds (saved, workAreas, fallback) {
  const areas = (Array.isArray(workAreas) ? workAreas : []).filter(
    (a) => a && finite(a.x) !== null && finite(a.y) !== null &&
      finite(a.width) > 0 && finite(a.height) > 0)
  const src = (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : {}

  // 크기부터. 저장된 적이 없거나 숫자가 아니면 기본 크기다. 최소값보다 작게
  // 저장돼 있어도(손으로 고친 state.json) 올려 준다.
  let width = finite(src.width)
  let height = finite(src.height)
  if (!(width > 0)) width = fallback.width
  if (!(height > 0)) height = fallback.height
  width = Math.round(Math.max(width, fallback.minWidth || 0))
  height = Math.round(Math.max(height, fallback.minHeight || 0))

  const x = finite(src.x)
  const y = finite(src.y)
  // 자리를 저장한 적이 없거나(첫 실행) 화면 정보를 못 받았으면 크기만 정한다.
  if (x === null || y === null || areas.length === 0) return { width, height }

  const rect = { x: Math.round(x), y: Math.round(y), width, height }
  const enough = areas.some((area) => {
    const seen = overlap(rect, area)
    // 창보다 작은 화면이면 창 크기가 문턱이 된다 — 그러지 않으면 작은 화면에서
    // 멀쩡히 보이는 창을 "안 보인다"고 판정해 자꾸 가운데로 끌어온다.
    return seen &&
      seen.w >= Math.min(MIN_VISIBLE, width) &&
      seen.h >= Math.min(MIN_VISIBLE, height)
  })
  if (enough) return rect

  // 어느 화면에도 걸치지 않는다. 첫 화면 가운데로 데려온다 — 부르는 쪽이
  // 주 모니터를 맨 앞에 두어 넘긴다(main.js 의 workAreas).
  const home = areas[0]
  const w = Math.min(width, home.width)
  const h = Math.min(height, home.height)
  return {
    x: Math.round(home.x + (home.width - w) / 2),
    y: Math.round(home.y + (home.height - h) / 2),
    width: w,
    height: h
  }
}

module.exports = { fitWindowBounds, MIN_VISIBLE }
