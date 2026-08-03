'use strict'

// 화면에 그려진 체크 상자와 그것이 가리키는 Keep 노트 id 의 짝.
// id 를 DOM 속성(data-*, for/id)에 심지 않고 여기서만 들고 있는다 — Keep 의
// 값은 외부 데이터이므로 DOM 에 흘리는 표면을 최소로 둔다.
const rows = []

const listEl = document.getElementById('list')
const statusEl = document.getElementById('status')

function titleOf (note) {
  // textContent 를 쓴다. Keep 본문은 외부 데이터이므로 innerHTML 은 쓰지 않는다.
  return note.title || (note.text || '').split('\n')[0] || '(제목없음)'
}

function render (notes, visibleIds) {
  const visible = new Set(visibleIds)
  rows.length = 0
  listEl.textContent = ''

  if (notes.length === 0) {
    const li = document.createElement('li')
    const msg = document.createElement('span')
    msg.className = 'empty'
    msg.textContent = 'Keep 에 메모가 없습니다. [+ 새 메모] 로 하나 만들어 보세요.'
    li.append(msg)
    listEl.append(li)
    return
  }

  for (const note of notes) {
    const li = document.createElement('li')

    const label = document.createElement('label')
    label.className = 'row'

    const check = document.createElement('input')
    check.type = 'checkbox'
    // 체크된 집합 = 바탕화면에 떠 있는 집합. 창이 열려 있으면 체크된 채로
    // 그린다. 책갈피로 접어둔 메모도 바탕화면에 있는 것이므로 체크된다.
    check.checked = visible.has(note.id)

    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = titleOf(note)
    title.title = titleOf(note)

    label.append(check, title)

    const date = document.createElement('span')
    date.className = 'date'
    date.textContent = (note.updated || '').slice(0, 10)

    li.append(label, date)
    listEl.append(li)
    rows.push({ id: note.id, check })
  }
}

/** 체크 상태만 실제 바탕화면 상태로 다시 맞춘다. 목록 자체는 다시 그리지 않는다. */
async function refreshChecks () {
  const visible = new Set(await window.keepSticky.visibleIds())
  for (const row of rows) row.check.checked = visible.has(row.id)
}

async function reload () {
  const [{ notes }, visibleIds] = await Promise.all([
    window.keepSticky.listNotes(),
    window.keepSticky.visibleIds()
  ])
  render(notes, visibleIds)
}

document.getElementById('apply').addEventListener('click', async () => {
  const checked = rows.filter((r) => r.check.checked).map((r) => r.id)
  statusEl.textContent = '적용 중…'
  // 체크된 집합을 그대로 넘긴다. 무엇을 열고 무엇을 내릴지는 main 프로세스가
  // selection-reconcile 로 계산한다. 내리는 것은 바탕화면에서 내리는 것이지
  // Keep 메모를 지우는 것이 아니다 — 삭제는 포스트잇 우클릭 경로에만 있다.
  const res = await window.keepSticky.applySelection(checked)
  await refreshChecks()
  statusEl.textContent = res.opened === 0 && res.closed === 0
    ? '바뀐 것이 없습니다'
    : `${res.opened}개 띄우고 ${res.closed}개 내렸습니다`
})

document.getElementById('new').addEventListener('click', async () => {
  statusEl.textContent = '새 메모 만드는 중…'
  const note = await window.keepSticky.createNote('', '')
  await window.keepSticky.openNote(note.id)
  await reload()
  statusEl.textContent = '새 메모를 바탕화면에 띄웠습니다'
})

// 포스트잇을 ✕ 로 내리거나 휴지통으로 보내면 목록의 체크 상태가 실제와
// 어긋난다. 그 상태로 [완료] 를 누르면 방금 내린 메모가 다시 떠 버린다.
// 목록 창으로 돌아올 때마다 실제 상태를 다시 읽어 맞춘다.
window.addEventListener('focus', () => { refreshChecks().catch(() => {}) })

reload()
