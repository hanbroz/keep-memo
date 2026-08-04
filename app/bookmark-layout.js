'use strict'

/**
 * 접힌 메모(책갈피) 한 장의 크기.
 *
 * 세로로 한 줄에 한 글자씩 최대 10 글자를 그리므로 높이는 그 10 줄이 잘리지
 * 않는 값이어야 한다. main 프로세스와 테스트가 같은 숫자를 봐야 하므로
 * 여기 한 곳에만 둔다.
 *
 * **장 사이 간격(gap)이 없다.** 예전에는 8px 을 두었지만, 같은 변에 붙은
 * 책갈피는 빈틈없이 이어져야 한다 — 사이가 벌어지면 그 틈으로 뒤 창이 비쳐
 * 띠가 끊겨 보인다. 장과 장을 눈으로 가르는 일은 note.html 이 책갈피 위쪽에
 * 긋는 가는 선이 대신한다.
 */
const BOOKMARK = { width: 44, height: 200 }

/**
 * 한 묶음(같은 모니터의 같은 변)에 붙은 책갈피들을 **빈틈도 겹침도 없이** 쌓는다.
 *
 * Electron 을 require 하지 않는 순수 함수다. 호출자가 그 모니터의
 * `screen.getDisplayMatching(bounds).workArea` 를 넘긴다 — 그래야 그 메모가
 * 올라가 있는 모니터에 붙고 주 모니터로 끌려가지 않는다. workArea 를 쓰는
 * 이유는 작업 표시줄을 덮지 않기 위해서다. 좌표계는 Electron 의 전역 화면
 * 좌표이고, 보조 모니터의 workArea.x / y 는 0 이 아니다(주 모니터 왼쪽에
 * 있으면 음수다).
 *
 * **왜 한 장씩이 아니라 묶음으로 계산하는가.** 예전에는 배치 규칙이 두 벌이었다
 * — 자동으로 줄을 세우는 것과, 사용자가 끌어다 놓은 자리를 그대로 쓰는 것.
 * 두 규칙이 같은 변에서 서로를 모른 채 각자 y 를 정하니 겹치거나 사이가 벌어지는
 * 것이 필연이었다(사람이 200px 격자에 픽셀 단위로 맞출 수는 없다). 자리는
 * 언제나 묶음 전체를 보고 정해야 하고, 사용자가 정하는 것은 **줄의 시작점과
 * 순서**까지다.
 *
 * 순서: 끌어다 놓은 적이 있는 것은 그 세로 위치(y) 순으로, 한 번도 안 옮긴
 * 것은 그 뒤에 접힌 순서대로 붙는다. 위치로 정렬하므로 위아래로 끌면 줄 안에서
 * 순서가 바뀐다 — 놓은 자리에 가장 가까운 결과다.
 *
 * 줄의 시작점: 끌어다 놓은 것이 하나라도 있으면 그 중 가장 위를 따르고, 아무도
 * 안 옮겼으면 작업 영역 맨 위다(이 함수가 생기기 전의 동작).
 *
 * 넘침 처리: 한 열에 들어갈 수 있는 장수를 넘어가면 화면 밖으로 그리는 대신
 * 안쪽으로 한 열 옮겨 다시 시작점에서부터 쌓는다. 열이 계속 늘어 작업 영역
 * 밖으로 밀리면 x 를 작업 영역 안으로 고정한다 — 그 지점부터는 겹치지만,
 * 적어도 화면 밖으로 사라져 못 찾는 창은 생기지 않는다.
 *
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {Array<{id:*, y:?number}>} members
 *   이 묶음의 책갈피들. y 는 사용자가 끌어다 놓은 세로 위치이고, 한 번도
 *   옮긴 적이 없으면 null(또는 숫자가 아닌 값)이다.
 * @param {'left'|'right'} [side] 붙일 변. 모르는 값은 오른쪽으로 본다.
 * @param {{width:number,height:number}} [size]
 * @returns {Array<{id:*, bounds:{x:number,y:number,width:number,height:number}}>}
 */
function packBookmarks (workArea, members, side = 'right', size = BOOKMARK) {
  // 작업 영역보다 큰 책갈피는 애초에 다 그릴 수 없다. 잘라서라도 안에 넣는다.
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  const bottom = workArea.y + workArea.height

  // 정렬은 안정적이어야 한다. y 가 같은 두 장의 앞뒤가 다시 그릴 때마다 바뀌면
  // 책갈피가 이유 없이 자리를 맞바꾼다 — 그래서 원래 순서(i)를 두 번째 열쇠로 쓴다.
  const ordered = members
    .map((m, i) => ({ m, i, key: Number.isFinite(m && m.y) ? m.y : Infinity }))
    .sort((a, b) => (a.key - b.key) || (a.i - b.i))

  const anchored = ordered.filter((e) => e.key !== Infinity)
  const rawTop = anchored.length ? anchored[0].key : workArea.y
  // 시작점을 작업 영역 안으로 조인다. 저장해 둔 뒤에 해상도가 바뀌거나 작업
  // 표시줄이 커질 수 있고, 그러면 그 값이 화면 밖을 가리킨다 — 못 찾는 책갈피는
  // 없는 책갈피다. 아래 perColumn 이 1 이상임도 이 조이기가 보장한다.
  const top = Math.min(Math.max(rawTop, workArea.y), Math.max(workArea.y, bottom - height))
  const perColumn = Math.max(1, Math.floor((bottom - top) / height))

  return ordered.map((entry, rank) => {
    const column = Math.floor(rank / perColumn)
    const row = rank % perColumn
    // 넘친 열은 붙은 변에서 화면 안쪽으로 파고든다.
    const rawX = side === 'left'
      ? workArea.x + column * width
      : workArea.x + workArea.width - width - column * width
    return {
      id: entry.m.id,
      bounds: {
        x: Math.min(Math.max(rawX, workArea.x), workArea.x + workArea.width - width),
        y: top + row * height,
        width,
        height
      }
    }
  })
}

/**
 * 끌어다 놓은 화면 좌표를 저장할 앵커로 바꾼다.
 *
 * 변은 놓은 자리에서 가까운 쪽으로 붙인다 — 책갈피는 화면 가장자리에 붙어 있어야
 * 본문을 가리지 않는다. 판단 기준을 책갈피의 **가운데**로 잡는 것이 중요하다:
 * 왼쪽 모서리로 재면 폭 44px 만큼 오른쪽으로 치우쳐, 화면 한가운데에 놓았는데
 * 오른쪽으로 붙는 일이 생긴다.
 *
 * 여기서 나온 y 는 "이 줄이 시작했으면 하는 자리"이자 "줄 안에서 몇 번째"를
 * 정하는 값이다. 실제로 놓이는 자리는 packBookmarks 가 묶음 전체를 보고 정한다.
 *
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {{x:number,y:number}} dropped 놓은 순간의 창 왼쪽 위 좌표.
 * @param {{width:number,height:number}} [size]
 * @returns {{side:'left'|'right', y:number}}
 */
function bookmarkAnchorFromDrop (workArea, dropped, size = BOOKMARK) {
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  const center = dropped.x + width / 2
  const maxY = workArea.y + workArea.height - height
  return {
    side: center < workArea.x + workArea.width / 2 ? 'left' : 'right',
    y: Math.min(Math.max(dropped.y, workArea.y), Math.max(workArea.y, maxY))
  }
}

module.exports = { packBookmarks, bookmarkAnchorFromDrop, BOOKMARK }
