'use strict'

/**
 * 접힌 메모(책갈피) 한 장의 크기와 장 사이 간격.
 *
 * 세로로 한 줄에 한 글자씩 최대 10 글자를 그리므로 높이는 그 10 줄이 잘리지
 * 않는 값이어야 한다. main 프로세스와 테스트가 같은 숫자를 봐야 하므로
 * 여기 한 곳에만 둔다.
 */
const BOOKMARK = { width: 44, height: 200, gap: 8 }

/**
 * 책갈피 한 장이 놓일 화면 좌표를 구한다.
 *
 * Electron 을 require 하지 않는 순수 함수다. 호출자가
 * `screen.getDisplayMatching(bounds).workArea` 를 넘긴다 — 그래야 "그 메모가
 * 지금 올라가 있는 모니터"의 오른쪽 가장자리에 붙고, 주 모니터로 끌려가지
 * 않는다. workArea 를 쓰는 이유는 작업 표시줄을 덮지 않기 위해서다.
 *
 * 좌표계는 Electron 의 전역 화면 좌표다. 보조 모니터의 workArea.x / workArea.y
 * 는 0 이 아니며(주 모니터 왼쪽에 있으면 음수다) 이 함수는 그 원점을 그대로
 * 더해 쓴다.
 *
 * 넘침 처리: 한 열(column)에 들어갈 수 있는 장수를 넘어가면 화면 밖으로
 * 그리는 대신 왼쪽으로 한 열 옮겨 다시 위에서부터 쌓는다. 열이 계속 늘어
 * 작업 영역 왼쪽까지 밀리면 x 를 workArea.x 로 고정한다 — 그 지점부터는
 * 책갈피끼리 겹치지만, 적어도 화면 밖으로 사라져 못 찾는 창은 생기지 않는다.
 * 책갈피 한 장이 작업 영역보다 크면 작업 영역 크기로 줄인다.
 *
 * @param {{x:number,y:number,width:number,height:number}} workArea
 *   책갈피를 붙일 모니터의 작업 영역.
 * @param {number} slotIndex 그 모니터에서 몇 번째로 접혔는가. 0 부터.
 * @param {{width:number,height:number,gap:number}} [size] 책갈피 크기와 간격.
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function bookmarkBounds (workArea, slotIndex, size = BOOKMARK) {
  const gap = Number.isFinite(size.gap) ? size.gap : BOOKMARK.gap
  // 작업 영역보다 큰 책갈피는 애초에 다 그릴 수 없다. 잘라서라도 안에 넣는다.
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)

  // 렌더러/IPC 를 거쳐 들어온 값이 정수가 아닐 수 있다. 음수 슬롯은 0 으로 본다.
  const index = Number.isFinite(slotIndex) ? Math.max(0, Math.floor(slotIndex)) : 0

  // 마지막 한 장은 뒤에 간격이 붙지 않으므로 height+gap 로 나누기 전에 gap 을
  // 더해 준다. 한 장도 못 들어가는 극단(높이 > 작업 영역)에서도 최소 1 이다.
  const perColumn = Math.max(1, Math.floor((workArea.height + gap) / (height + gap)))
  const column = Math.floor(index / perColumn)
  const row = index % perColumn

  const rawX = workArea.x + workArea.width - width - column * (width + gap)
  return {
    x: Math.max(workArea.x, rawX),
    y: workArea.y + row * (height + gap),
    width,
    height
  }
}

module.exports = { bookmarkBounds, BOOKMARK }
