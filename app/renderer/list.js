'use strict'

// 이 파일의 상태는 셋으로 나뉘어 있고, 그 분리가 검색 기능의 안전장치다.
//
//  allNotes    — list_notes 가 준 **전체** 노트. 검색과 무관하게 그대로 있다.
//  checkedIds  — 체크된 노트 id 의 집합. 기준은 화면에 그려진 행이 아니라 전체
//                노트다. 검색으로 걸러져 사라진 행의 체크도 여기 그대로 남고,
//                다시 걸러 들어오면 체크된 채로 다시 그려진다.
//  renderedRows— 지금 DOM 에 있는 행들(id ↔ 체크 상자 짝). 검색할 때마다 갈린다.
//
// 예전에는 rows 하나가 이 셋을 겸했다 — 화면에 그려진 행이 곧 체크 상태였고 곧
// 전체 목록이었다. 검색이 들어오면 그 등식이 깨지고, 그 상태로 [완료] 를 누르면
// 지금 안 보이는 메모가 "체크 안 된 것"으로 읽혀 조용히 내려간다. 그래서 체크는
// DOM 이 아니라 checkedIds 가 들고 있고, [완료] 는 selectionToApply() 로 전체
// 노트를 훑어 목록을 만든다.
//
// Keep 의 노트 id 는 DOM 속성(data-*, for/id)에 심지 않는다 — 외부 데이터가
// DOM 에 드러나는 표면을 최소로 둔다. id 는 renderedRows 와 checkedIds 안에만
// 있다.
let allNotes = []
// 목록을 한 번이라도 제대로 받아왔는가. 못 받아온 상태의 [완료] 는 "아무것도
// 체크되지 않았다"와 구별할 수 없고, 그대로 보내면 떠 있는 포스트잇이 전부
// 내려간다. 그래서 이 깃발이 서기 전에는 반영 자체를 하지 않는다.
let notesLoaded = false
const checkedIds = new Set()
const renderedRows = []

const listEl = document.getElementById('list')
const statusEl = document.getElementById('status')
const searchEl = document.getElementById('search')
const panelEl = document.getElementById('settings')
const toggleEl = document.getElementById('settings-toggle')
const familyEl = document.getElementById('font-family')
const titleSizeEl = document.getElementById('font-title-size')
const bodySizeEl = document.getElementById('font-body-size')

function titleOf (note) {
  // textContent 를 쓴다. Keep 본문은 외부 데이터이므로 innerHTML 은 쓰지 않는다.
  return note.title || (note.text || '').split('\n')[0] || '(제목없음)'
}

function showEmpty (message) {
  const li = document.createElement('li')
  const msg = document.createElement('span')
  msg.className = 'empty'
  msg.textContent = message
  li.append(msg)
  listEl.append(li)
}

/** 지금의 검색어에 맞는 행만 다시 그린다. 체크 상태는 checkedIds 에서 온다. */
function render () {
  const query = searchEl.value
  const shown = filterNotes(allNotes, query)
  renderedRows.length = 0
  listEl.textContent = ''

  if (shown.length === 0) {
    showEmpty(allNotes.length === 0
      ? 'Keep 에 메모가 없습니다. [+ 새 메모] 로 하나 만들어 보세요.'
      : '검색과 맞는 메모가 없습니다.')
    return
  }

  for (const note of shown) {
    const li = document.createElement('li')

    const label = document.createElement('label')
    label.className = 'row'

    const check = document.createElement('input')
    check.type = 'checkbox'
    // 체크된 집합 = 바탕화면에 떠 있는 집합. 창이 열려 있으면 체크된 채로
    // 그린다. 책갈피로 접어둔 메모도 바탕화면에 있는 것이므로 체크된다.
    check.checked = checkedIds.has(note.id)
    // 체크는 곧바로 checkedIds 에 옮겨 적는다. 이 행이 다음 검색에서 사라져도
    // 사용자의 선택은 그 집합에 남는다.
    check.addEventListener('change', () => {
      if (check.checked) checkedIds.add(note.id)
      else checkedIds.delete(note.id)
    })

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
    renderedRows.push({ id: note.id, check })
  }
}

/**
 * 체크 상태만 실제 바탕화면 상태로 다시 맞춘다. 목록 자체는 다시 그리지 않고,
 * 검색어도 건드리지 않는다.
 *
 * checkedIds 를 통째로 갈아 끼우는 것이 맞다 — 이 함수의 뜻이 "지금 화면의
 * 체크가 아니라 실제로 떠 있는 창이 진실이다"이기 때문이다. 검색이 없던 시절의
 * 코드도 그려진 모든 행의 체크를 실제 상태로 덮었으므로 동작이 같다.
 */
async function refreshChecks () {
  const visible = await window.keepSticky.visibleIds()
  checkedIds.clear()
  for (const id of visible) checkedIds.add(id)
  for (const row of renderedRows) row.check.checked = checkedIds.has(row.id)
}

async function reload () {
  const [{ notes }, visibleIds] = await Promise.all([
    window.keepSticky.listNotes(),
    window.keepSticky.visibleIds()
  ])
  allNotes = Array.isArray(notes) ? notes : []
  notesLoaded = true
  checkedIds.clear()
  for (const id of visibleIds) checkedIds.add(id)
  render()
}

document.getElementById('apply').addEventListener('click', async () => {
  if (!notesLoaded) {
    statusEl.textContent = '메모 목록을 아직 못 불러왔습니다. 잠시 뒤 다시 눌러 주세요.'
    return
  }
  // 화면에 보이는 행이 아니라 **전체** 노트를 훑는다. 검색으로 걸러진 메모의
  // 체크도 그대로 들어간다 — 이 한 줄이 "건드린 적 없는 포스트잇이 조용히
  // 내려가는" 사고를 막는다.
  const checked = selectionToApply(allNotes, checkedIds)
  statusEl.textContent = '적용 중…'
  // 체크된 집합을 그대로 넘긴다. 무엇을 열고 무엇을 내릴지는 main 프로세스가
  // selection-reconcile 로 계산한다. 내리는 것은 바탕화면에서 내리는 것이지
  // Keep 메모를 지우는 것이 아니다 — 삭제는 포스트잇 우클릭 경로에만 있다.
  const res = await window.keepSticky.applySelection(checked)
  // 창이 닫히더라도 체크 상태는 실제와 맞춰 둔다. 닫기가 어떤 이유로든 안
  // 되면 사용자는 올바른 상태의 창을 그대로 보게 된다.
  await refreshChecks()
  statusEl.textContent = res.opened === 0 && res.closed === 0
    ? '바뀐 것이 없습니다'
    : `${res.opened}개 띄우고 ${res.closed}개 내렸습니다`
  // 반영이 끝났으면 목록 창은 할 일을 다 했다. 앱은 트레이에서 계속 살아 있고,
  // 트레이 아이콘을 누르면 다시 열린다. 창이 사라지면서 이 렌더러도 같이
  // 사라지므로 결과를 기다리지 않는다(기다리면 영영 안 오는 약속이 된다).
  window.keepSticky.closeList().catch(() => {})
})

document.getElementById('new').addEventListener('click', async () => {
  statusEl.textContent = '새 메모 만드는 중…'
  const note = await window.keepSticky.createNote('', '')
  await window.keepSticky.openNote(note.id)
  await reload()
  statusEl.textContent = '새 메모를 바탕화면에 띄웠습니다'
})

// --- 검색 ------------------------------------------------------------------
//
// 버튼은 없다. 치는 대로 걸러진다. 거르는 규칙은 note-filter.js 에 있고 여기서는
// 언제 다시 그릴지만 정한다.
//
// 한글은 IME 조합을 거친다. "회"를 치는 동안 input 이벤트는 ㅎ → 호 → 회 로 세
// 번 오는데, 그 중간 상태(자모 하나)로 거르면 걸리는 메모가 없어 목록이 비었다
// 돌아왔다 하며 깜박인다. isComposing 이 켜진 input 은 흘려보내고, 조합이
// 끝나는 compositionend 에서 한 번 그린다. 그동안 화면에는 직전까지 확정된
// 글자로 거른 결과가 그대로 남아 있다.
searchEl.addEventListener('input', (e) => {
  if (e.isComposing) return
  render()
})
searchEl.addEventListener('compositionend', () => { render() })
// type="search" 의 ✕ 는 input 을 내므로 위에서 처리된다. Esc 도 같은 뜻으로 둔다.
searchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || searchEl.value === '') return
  e.preventDefault()
  searchEl.value = ''
  render()
})

// --- 서체 설정 --------------------------------------------------------------

/** 입력칸 세 개를 실제로 적용된 설정으로 맞춘다(잘린 값도 그대로 보이게). */
function showFontSettings (settings) {
  familyEl.value = settings.family
  titleSizeEl.value = String(settings.titlePt)
  bodySizeEl.value = String(settings.bodyPt)
}

function readFontInputs () {
  return { family: familyEl.value, titlePt: titleSizeEl.value, bodyPt: bodySizeEl.value }
}

/**
 * 고른 값을 화면에 입히고 저장한다. 화면에 먼저 입히는 이유는 반응이 즉각
 * 보이게 하기 위해서고, 저장 결과(=검증을 지난 값)가 오면 그것으로 한 번 더
 * 맞춘다 — 사용자가 999 를 넣었다면 입력칸도 조인 값으로 바뀌어야 한다.
 */
async function saveFontSettings (next) {
  const shownNow = applyFontSettings(next)
  showFontSettings(shownNow)
  const saved = await window.keepSticky.setFontSettings(shownNow)
  applyFontSettings(saved)
  showFontSettings(saved)
}

function buildFontChoices () {
  // option 은 createElement + textContent 로만 만든다. 글꼴 이름을 문자열로
  // 이어붙여 innerHTML 에 넣는 경로는 두지 않는다.
  for (const choice of FONT_CHOICES) {
    const opt = document.createElement('option')
    opt.value = choice.key
    opt.textContent = choice.label
    familyEl.append(opt)
  }
  for (const el of [titleSizeEl, bodySizeEl]) {
    el.min = String(FONT_PT_RANGE.min)
    el.max = String(FONT_PT_RANGE.max)
  }
}

toggleEl.addEventListener('click', () => {
  panelEl.hidden = !panelEl.hidden
  toggleEl.setAttribute('aria-expanded', String(!panelEl.hidden))
  if (!panelEl.hidden) familyEl.focus()
})
document.getElementById('settings-close').addEventListener('click', () => {
  panelEl.hidden = true
  toggleEl.setAttribute('aria-expanded', 'false')
  toggleEl.focus()
})
document.getElementById('font-reset').addEventListener('click', () => {
  saveFontSettings(DEFAULT_FONT_SETTINGS).catch(() => {})
})
// 숫자 칸은 input 이 아니라 change(칸을 벗어나거나 Enter)에서 반영한다. 매
// 글자마다 반영하면 "1" 을 친 순간 6 으로 조여져 "12" 를 칠 수가 없다.
familyEl.addEventListener('change', () => { saveFontSettings(readFontInputs()).catch(() => {}) })
titleSizeEl.addEventListener('change', () => { saveFontSettings(readFontInputs()).catch(() => {}) })
bodySizeEl.addEventListener('change', () => { saveFontSettings(readFontInputs()).catch(() => {}) })

// 다른 창에서 바뀐 설정도 다시 띄우지 않고 따라온다(지금은 이 창뿐이지만,
// 포스트잇이 같은 통로를 붙이면 그대로 양방향이 된다).
window.keepSticky.onFontSettings((settings) => {
  const applied = applyFontSettings(settings)
  showFontSettings(applied)
})

// 포스트잇을 ✕ 로 내리면 목록의 체크 상태가 실제와 어긋난다. 그 상태로 [완료]
// 를 누르면 방금 내린 메모가 다시 떠 버린다. 목록 창으로 돌아올 때마다 실제
// 상태를 다시 읽어 맞춘다.
window.addEventListener('focus', () => { refreshChecks().catch(() => {}) })

// 포스트잇을 휴지통으로 보내면 그 메모는 Keep 에서 사라진다 — 체크만 맞춰서는
// 안 되고 목록 자체를 다시 받아야 지운 행이 없어진다. main 이 trash 성공 직후에
// 알려준다. 창이 닫혀 있었다면 이 신호는 오지 않지만, 그때는 다음에 창을 열
// 때 어차피 reload() 로 시작하므로 지운 메모가 보일 일이 없다.
//
// 검색어는 건드리지 않는다(render() 가 지금 입력칸 값을 다시 읽는다). 체크
// 상태는 reload() 가 실제로 떠 있는 창들로 다시 맞춘다.
window.keepSticky.onNotesChanged(() => {
  reload().catch(() => {
    // 다시 못 받아왔다면 화면은 직전 목록 그대로 둔다 — 여기서 목록을 비우면
    // 사용자가 보고 있던 것이 통째로 사라진다. 상태 줄로만 알린다.
    statusEl.textContent = '목록을 새로 고치지 못했습니다.'
  })
})

// 저장된 설정을 IPC 로 읽어오기 전에 기본값을 먼저 입힌다. list.html 의 :root
// 는 note.html / setup-email.html 과 같은 값을 유지해야 하므로(세 벌 동기),
// "기본 서체로 첫 그림을 그리는 일"은 CSS 가 아니라 여기서 한다.
applyFontSettings(DEFAULT_FONT_SETTINGS)
buildFontChoices()
showFontSettings(DEFAULT_FONT_SETTINGS)

window.keepSticky.getFontSettings().then((settings) => {
  const applied = applyFontSettings(settings)
  showFontSettings(applied)
}).catch(() => {})

reload().catch((err) => {
  // 목록을 못 받아왔다. notesLoaded 가 서지 않으므로 [완료] 는 아무것도 내리지
  // 않는다 — 사용자가 이유를 알 수 있게 상태 줄에도 남긴다.
  listEl.textContent = ''
  showEmpty('메모 목록을 불러오지 못했습니다.')
  statusEl.textContent = err && err.message ? err.message : '메모 목록을 불러오지 못했습니다.'
})
