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
const toastEl = document.getElementById('toast')
const searchEl = document.getElementById('search')
const syncEl = document.getElementById('sync')
const labelFilterEl = document.getElementById('label-filter')
const labelsPanelEl = document.getElementById('labels')
const labelsToggleEl = document.getElementById('labels-toggle')
const labelRowsEl = document.getElementById('label-rows')
const newLabelEl = document.getElementById('new-label')

// 계정의 라벨 전부. 필터의 항목과 관리 패널의 행이 같은 값을 본다.
let allLabels = []
const panelEl = document.getElementById('settings')
const toggleEl = document.getElementById('settings-toggle')
const familyEl = document.getElementById('font-family')
const titleSizeEl = document.getElementById('font-title-size')
const bodySizeEl = document.getElementById('font-body-size')

function titleOf (note) {
  // textContent 를 쓴다. Keep 본문은 외부 데이터이므로 innerHTML 은 쓰지 않는다.
  //
  // 제목이 없어 본문 첫 줄을 대신 쓸 때는 체크리스트 표식을 뗀다. 체크리스트가
  // 메모 본문 안의 텍스트 규약이 되면서(line-model.js), 첫 줄이 항목인 메모가
  // 흔해졌다 — 그대로 두면 좁은 목록 행에서 "- [ ] " 여섯 글자가 낭비되고,
  // 그 표식은 사용자가 쓴 글자가 아니라 우리가 정한 규약이다.
  return note.title || parseNoteLine((note.text || '').split('\n')[0]).text || '(제목없음)'
}

// 토스트가 떠 있는 시간. 짧으면 "동기화했습니다"를 읽기 전에 사라지고, 길면
// 가운데를 오래 가린다.
const TOAST_MS = 2200
let toastTimer = null

/**
 * 시스템 메시지를 창 가운데에 잠깐 띄운다.
 *
 * 예전에는 푸터의 <span> 에 눌러 담았는데, 창이 좁으면 버튼들 사이에 끼어
 * "동/기/화/했/습/니/다" 처럼 세로로 깨졌다 — 목록 창은 360px 까지 좁힐 수 있고
 * 푸터에는 이미 단추가 다섯이다. 자리를 다투지 않는 곳은 창 위밖에 없다.
 *
 * @param {string} message
 * @param {{hold?: boolean}} [opts] hold 면 다음 토스트가 올 때까지 남는다.
 *   "동기화하는 중…" 처럼 **결과가 뒤따르는** 진행 문구에 쓴다. 저절로 사라지면
 *   사용자는 끝난 줄 알고, 실제로는 아직 도는 중이다.
 */
function showToast (message, { hold = false } = {}) {
  clearTimeout(toastTimer)
  toastEl.textContent = message
  toastEl.classList.add('show')
  if (hold) return
  toastTimer = setTimeout(() => { toastEl.classList.remove('show') }, TOAST_MS)
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
  const shown = filterNotes(allNotes, query, labelFilterEl.value)
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
    // 메모 색을 행 배경으로 옮긴다(실제 색 값과 규칙은 list.html 에 있다).
    // 색 이름은 Keep 이 정한 12개 중 하나짜리 열거값이라 노트 id 와 달리 DOM
    // 속성에 둬도 된다 — 감출 것이 없고, 오히려 CSS 가 읽을 수 있어야 한다.
    if (note.color) li.dataset.color = note.color

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

    // 왜 이 행이 위에 있는지를 표로 말해 준다. 묶음은 고정 → 보관 → 나머지이고
    // 정렬은 사이드카가 한다(_serialize_for_list). 어느 쪽도 목록에서 감추지
    // 않는다 — 감추면 이 앱에서 그 상태를 되돌릴 길이 사라진다.
    //
    // 둘 다 달린 메모는 '고정'만 보여준다. 고정이 이긴 묶음이고, 44px 남짓한
    // 행에 표를 두 개 붙이면 제목 자리를 잡아먹는다.
    const tagText = note.pinned ? '고정' : (note.archived ? '보관' : '')
    if (tagText) {
      const tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = tagText
      label.append(tag)
    }

    // 이 메모가 어느 카테고리인지. 이름은 Keep 에서 온 외부 데이터이므로
    // textContent 로만 넣는다(innerHTML 경로를 두지 않는다).
    //
    // 반복 변수를 noteLabel 로 둔 것은 취향이 아니다 — 위 행의 <label> 요소가
    // 이미 label 이라, 여기서 label 을 쓰면 그것을 가려 칩이 자기 자신 안으로
    // 들어간다.
    for (const noteLabel of Array.isArray(note.labels) ? note.labels : []) {
      const chip = document.createElement('span')
      chip.className = 'label-chip'
      chip.textContent = noteLabel.name
      chip.title = noteLabel.name
      label.append(chip)
    }

    const date = document.createElement('span')
    date.className = 'date'
    // 정렬 기준과 **같은 값**을 보여준다. 작성일로 줄을 세워 놓고 수정일을
    // 찍으면 날짜 칸이 뒤죽박죽으로 보여 목록이 안 맞춰진 것처럼 읽힌다.
    // created 가 없는 응답(옛 사이드카)에서는 예전처럼 updated 를 쓴다.
    date.textContent = (note.created || note.updated || '').slice(0, 10)

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

/**
 * 새로 받은 노트 목록과 지금 바탕화면 상태로 화면을 다시 세운다. reload() 와
 * [동기화] 가 둘 다 쓴다 — 노트를 어디서 받아왔는지(listNotes 인지 syncNotes
 * 인지)만 다르고 그 뒤에 할 일은 같다.
 *
 * 검색어는 건드리지 않는다 — render() 가 지금 입력칸 값을 그대로 다시 읽는다.
 * 체크 상태는 여기서 실제 바탕화면(visibleIds)으로 통째로 다시 맞춘다:
 * [동기화]가 다른 기기에서 사라진 메모의 포스트잇을 main 프로세스 쪽에서
 * 이미 내렸을 수 있으므로(sync-reconcile.js), 화면의 체크도 그 결과를 그대로
 * 따라가야 한다.
 */
function applyNotesAndVisible (notes, visibleIds) {
  allNotes = Array.isArray(notes) ? notes : []
  notesLoaded = true
  checkedIds.clear()
  for (const id of visibleIds) checkedIds.add(id)
  render()
}

async function reload () {
  const [{ notes }, visibleIds] = await Promise.all([
    window.keepSticky.listNotes(),
    window.keepSticky.visibleIds()
  ])
  applyNotesAndVisible(notes, visibleIds)
}

// 이미 진행 중인 동기화가 있는가. 응답을 기다리는 동안 두 번째 클릭이 쌓이지
// 않게 한다 — 버튼을 disabled 로 두는 것과 별개로, 더블클릭처럼 disabled 반영
// 전에 두 번째 이벤트가 낄 수 있는 경로까지 막는다.
let syncing = false

/**
 * [동기화]. 사이드카에서 keep.sync() 를 부른 뒤 다시 읽은 목록을 받아온다 —
 * 다른 기기(폰이나 keep.google.com)에서 생긴 변경, 특히 삭제가 이 세션에
 * 반영되는 유일한 통로다(재시작 말고는). 네트워크 왕복이라 눈에 띄게 걸릴 수
 * 있으므로 진행 중/끝난 결과를 모두 상태 줄에 남긴다.
 */
async function syncNotes () {
  if (syncing) return
  syncing = true
  syncEl.disabled = true
  showToast('동기화하는 중…', { hold: true })
  try {
    let res = await window.keepSticky.syncNotes()

    // 자격증명이 무효가 됐다. 예전에는 '재로그인이 필요합니다'라고 **말만** 했고,
    // 실제로 다시 로그인하는 통로는 최초 실행 경로 하나뿐이라 사용자는 여기서
    // 막혔다(재시작해도 auth_status 가 토큰의 존재만 보므로 로그인 창이 뜨지
    // 않는다). 사용자가 방금 [동기화] 를 눌렀으니 로그인 창을 띄우는 것이 그
    // 요청의 자연스러운 이어짐이다 — 묻지 않고 연다.
    if (!res.ok && res.code === 'AUTH_REQUIRED') {
      showToast('재로그인이 필요합니다. 로그인 창을 엽니다…', { hold: true })
      const login = await window.keepSticky.relogin()
      if (!login.ok) {
        showToast(`다시 로그인하지 못했습니다: ${login.message}`)
        return
      }
      // 새 자격증명으로 한 번만 다시 시도한다. 여기서 또 인증에 걸리면 되풀이
      // 하지 않는다 — 로그인 창을 무한히 띄우느니 사실대로 알리는 편이 낫다.
      showToast('다시 로그인했습니다. 동기화하는 중…', { hold: true })
      res = await window.keepSticky.syncNotes()
    }

    if (!res.ok) {
      showToast(res.code === 'AUTH_REQUIRED'
        ? '재로그인했지만 여전히 인증에 실패합니다.'
        : `동기화하지 못했습니다: ${res.message}`)
      return
    }
    const visibleIds = await window.keepSticky.visibleIds()
    applyNotesAndVisible(res.notes, visibleIds)
    showToast('동기화했습니다')
  } catch (err) {
    // notes:sync 는 { ok:false } 로 실패를 돌려주는 것이 정상 경로지만,
    // IPC 자체가 끊기는 것처럼 던지는 경로도 이론상 남아 있을 수 있다 —
    // 여기서도 침묵하지 않는다.
    showToast(err && err.message ? `동기화하지 못했습니다: ${err.message}` : '동기화하지 못했습니다')
  } finally {
    syncing = false
    syncEl.disabled = false
  }
}
syncEl.addEventListener('click', () => { syncNotes() })

document.getElementById('apply').addEventListener('click', async () => {
  if (!notesLoaded) {
    showToast('메모 목록을 아직 못 불러왔습니다. 잠시 뒤 다시 눌러 주세요.')
    return
  }
  // 화면에 보이는 행이 아니라 **전체** 노트를 훑는다. 검색으로 걸러진 메모의
  // 체크도 그대로 들어간다 — 이 한 줄이 "건드린 적 없는 포스트잇이 조용히
  // 내려가는" 사고를 막는다.
  const checked = selectionToApply(allNotes, checkedIds)
  showToast('적용 중…', { hold: true })
  // 체크된 집합을 그대로 넘긴다. 무엇을 열고 무엇을 내릴지는 main 프로세스가
  // selection-reconcile 로 계산한다. 내리는 것은 바탕화면에서 내리는 것이지
  // Keep 메모를 지우는 것이 아니다 — 삭제는 포스트잇 우클릭 경로에만 있다.
  const res = await window.keepSticky.applySelection(checked)
  // 창이 닫히더라도 체크 상태는 실제와 맞춰 둔다. 닫기가 어떤 이유로든 안
  // 되면 사용자는 올바른 상태의 창을 그대로 보게 된다.
  await refreshChecks()
  showToast(res.opened === 0 && res.closed === 0
    ? '바뀐 것이 없습니다'
    : `${res.opened}개 띄우고 ${res.closed}개 내렸습니다`)
  // 반영이 끝났으면 목록 창은 할 일을 다 했다. 앱은 트레이에서 계속 살아 있고,
  // 트레이 아이콘을 누르면 다시 열린다. 창이 사라지면서 이 렌더러도 같이
  // 사라지므로 결과를 기다리지 않는다(기다리면 영영 안 오는 약속이 된다).
  window.keepSticky.closeList().catch(() => {})
})

document.getElementById('new').addEventListener('click', async () => {
  showToast('새 메모 만드는 중…', { hold: true })
  const note = await window.keepSticky.createNote('', '')
  await window.keepSticky.openNote(note.id)
  await reload()
  showToast('새 메모를 바탕화면에 띄웠습니다')
})

// --- Keep 열기 ---------------------------------------------------------------
//
// 주소를 여기서 만들지 않는다. 이 앱이 로그인한 계정을 실어 보내야 브라우저의
// 기본 구글 계정이 아니라 **그 계정의** 메모가 열리는데(url-open.js 의
// keepListUrl), 그 이메일을 렌더러로 끌어오지 않으려고 만드는 일까지 main 에
// 맡겼다. 실제로 여는 것도 main 이다 — 검증하는 자리는 언제나 한 곳이어야 한다.
document.getElementById('open-keep').addEventListener('click', async () => {
  const res = await window.keepSticky.openKeep()
  // 아무 일도 일어나지 않는 것이 제일 나쁘다 — 사용자는 기능이 고장 났다고
  // 읽는다. 브라우저가 없거나 열기가 거절되면 상태 줄로 알린다.
  if (res && res.ok) return
  showToast('브라우저를 열지 못했습니다.')
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
// --- 라벨 (카테고리) ---------------------------------------------------------
//
// 라벨은 노트의 필드가 아니라 계정에 따로 사는 개체다. 그래서 관리(이름 바꾸기,
// 지우기)를 메모 한 장이 아니라 이 창에 둔다 — 한 번의 이름 변경이 그 라벨이
// 붙은 모든 메모에 걸린다.
//
// 언제나 id 로 다룬다. 이름을 열쇠로 쓰면 이름을 바꾼 순간 그 라벨이 붙은 메모를
// 전부 놓친다.

/** 필터 <select> 를 지금의 라벨로 다시 채운다. 고른 값은 살아 있으면 지킨다. */
function buildLabelFilter () {
  const previous = labelFilterEl.value
  labelFilterEl.textContent = ''
  const add = (value, text) => {
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = text // 라벨 이름은 외부 데이터다. innerHTML 경로를 두지 않는다.
    labelFilterEl.append(opt)
  }
  add('', '모든 라벨')
  add(LABEL_FILTER_NONE, '라벨 없음')
  for (const label of allLabels) add(label.id, label.name)

  // 방금 지운 라벨이 골라져 있었다면 '모든 라벨'로 돌아간다. 그대로 두면 없는
  // id 로 걸러 목록이 통째로 비고, 사용자는 메모가 사라졌다고 읽는다.
  labelFilterEl.value = [...labelFilterEl.options].some((o) => o.value === previous)
    ? previous
    : ''
  labelFilterEl.classList.toggle('on', labelFilterEl.value !== '')
}

/** 관리 패널의 행을 다시 그린다. 행마다 이름 입력칸과 [삭제] 가 있다. */
function buildLabelRows () {
  labelRowsEl.textContent = ''
  if (allLabels.length === 0) {
    const li = document.createElement('li')
    const msg = document.createElement('span')
    msg.className = 'hint'
    msg.textContent = '아직 라벨이 없습니다. 아래에서 만들어 보세요.'
    li.append(msg)
    labelRowsEl.append(li)
    return
  }
  for (const label of allLabels) {
    const li = document.createElement('li')

    const input = document.createElement('input')
    input.type = 'text'
    input.value = label.name
    input.maxLength = 50
    input.setAttribute('aria-label', `${label.name} 이름 바꾸기`)
    // change 는 칸을 벗어나거나 Enter 를 쳤을 때만 온다. 글자마다 보내면
    // 한 글자 지운 순간 "빈 이름"으로 거절당한다.
    input.addEventListener('change', () => { renameLabel(label, input) })

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'label-delete'
    del.textContent = '삭제'
    del.title = `${label.name} 라벨을 지웁니다 (메모는 지워지지 않습니다)`
    del.addEventListener('click', () => { deleteLabel(label) })

    li.append(input, del)
    labelRowsEl.append(li)
  }
}

/** 계정의 라벨을 받아와 필터와 관리 패널을 다시 세운다. */
async function loadLabels () {
  const res = await window.keepSticky.listLabels()
  if (!res.ok) {
    showToast(res.code === 'AUTH_REQUIRED'
      ? '재로그인이 필요합니다'
      : `라벨을 불러오지 못했습니다: ${res.message}`)
    return
  }
  allLabels = Array.isArray(res.labels) ? res.labels : []
  buildLabelFilter()
  buildLabelRows()
}

async function renameLabel (label, input) {
  const next = input.value.trim()
  if (next === '' || next === label.name) {
    input.value = label.name // 되돌린다. 빈 이름은 사이드카가 거절한다.
    return
  }
  const res = await window.keepSticky.renameLabel(label.id, next)
  if (!res.ok) {
    input.value = label.name
    showToast(`이름을 바꾸지 못했습니다: ${res.message}`)
    return
  }
  showToast(`'${label.name}' 을 '${res.label.name}' 으로 바꿨습니다`)
  await loadLabels()
  // 행에 붙은 칩의 글자도 바뀌어야 한다. 노트가 들고 있는 것은 이름의 복사본이다.
  await reload()
}

async function deleteLabel (label) {
  // 되돌릴 수 없다(라벨에는 휴지통이 없다). 반드시 물어본다 — 포스트잇의
  // [삭제] 와 같은 관례다.
  const ok = window.confirm(
    `'${label.name}' 라벨을 지울까요?\n\n` +
    '이 라벨이 붙은 모든 메모에서 떨어집니다. 메모 자체는 지워지지 않습니다.'
  )
  if (!ok) return
  const res = await window.keepSticky.deleteLabel(label.id)
  if (!res.ok) {
    showToast(`라벨을 지우지 못했습니다: ${res.message}`)
    return
  }
  showToast(`'${label.name}' 라벨을 지웠습니다`)
  await loadLabels()
  await reload()
}

async function addLabel () {
  const name = newLabelEl.value.trim()
  if (name === '') return
  const res = await window.keepSticky.createLabel(name)
  if (!res.ok) {
    showToast(`라벨을 만들지 못했습니다: ${res.message}`)
    return
  }
  newLabelEl.value = ''
  showToast(`'${res.label.name}' 라벨을 만들었습니다`)
  await loadLabels()
}

labelFilterEl.addEventListener('change', () => {
  labelFilterEl.classList.toggle('on', labelFilterEl.value !== '')
  render()
})

labelsToggleEl.addEventListener('click', () => {
  labelsPanelEl.hidden = !labelsPanelEl.hidden
  labelsToggleEl.setAttribute('aria-expanded', String(!labelsPanelEl.hidden))
  if (!labelsPanelEl.hidden) newLabelEl.focus()
})
document.getElementById('labels-close').addEventListener('click', () => {
  labelsPanelEl.hidden = true
  labelsToggleEl.setAttribute('aria-expanded', 'false')
  labelsToggleEl.focus()
})
document.getElementById('add-label').addEventListener('click', () => { addLabel() })
newLabelEl.addEventListener('keydown', (e) => {
  // 한글은 IME 조합을 거친다. 조합을 끝내는 Enter 까지 "추가"로 읽으면 글자가
  // 덜 만들어진 채로 보내진다 — 검색칸이 isComposing 을 보는 것과 같은 이유다.
  if (e.key !== 'Enter' || e.isComposing) return
  e.preventDefault()
  addLabel()
})

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
// 포스트잇에서 색을 바꾸면 목록 행의 배경도 같이 바뀌어야 한다. 목록을 다시
// 읽지 않고 손에 있는 노트의 color 만 갈아 끼운 뒤 다시 그린다 — render() 는
// 체크 상태를 checkedIds 에서 읽으므로, 아직 [완료] 를 누르지 않은 체크가
// 그대로 남는다(reload() 였다면 실제로 떠 있는 창들로 덮여 날아갔을 것이다).
// 검색어도 그대로다(render() 가 지금 입력칸 값을 다시 읽는다).
window.keepSticky.onNoteColor((id, color) => {
  const note = allNotes.find((n) => n.id === id)
  // 목록을 아직 못 받아왔거나 그 사이 사라진 메모라면 할 일이 없다. 같은 색이
  // 다시 온 경우도 마찬가지다 — 굳이 목록을 다시 그리지 않는다.
  if (!note || note.color === color) return
  note.color = color
  render()
})

window.keepSticky.onNotesChanged(() => {
  reload().catch(() => {
    // 다시 못 받아왔다면 화면은 직전 목록 그대로 둔다 — 여기서 목록을 비우면
    // 사용자가 보고 있던 것이 통째로 사라진다. 상태 줄로만 알린다.
    showToast('목록을 새로 고치지 못했습니다.')
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

// 창이 뜰 때 두 걸음으로 그린다.
//
//  1. reload() — list_notes 는 sync 를 부르지 않아 즉시 돌아온다. 캐시된 목록으로
//     창을 곧바로 쓸 만하게 만든다.
//  2. syncNotes() — 그 다음 서버와 맞춘다. list_notes 만으로는 폰이나
//     keep.google.com 에서 생긴 변경(보관, 삭제, 새 메모)이 이 세션에 영영
//     반영되지 않는다. "앱의 보관 항목과 Keep 의 보관 항목이 다르다"의 나머지
//     절반이 이것이었다.
//
// 순서가 중요하다. 곧바로 syncNotes() 부터 하면 네트워크 왕복 동안 빈 창이 뜬다.
//
// **이미 떠 있는 창을 앞으로 가져올 때는 하지 않는다.** syncNotes() 안의
// applyNotesAndVisible 이 체크된 집합을 실제로 떠 있는 창들로 통째로 덮기 때문에,
// 체크만 해두고 [완료] 를 아직 안 누른 사용자의 선택이 날아간다. 창이 새로 뜨는
// 지금은 어차피 체크를 처음 세우는 참이라 잃을 것이 없다. ([완료] 가 창을 닫으므로
// 실제로 대부분의 '열기'가 이 경로다. 이미 떠 있는 창은 [동기화] 로 맞춘다.)
reload().then(() => {
  // 라벨은 목록과 독립이라 기다리지 않는다 — 실패해도 목록은 그대로 쓸 수 있어야
  // 하고, 성공하면 필터가 조용히 채워진다.
  loadLabels().catch(() => {})
  return syncNotes()
}).then(() => {
  // 동기화가 끝나면 라벨도 서버 것으로 다시 읽는다. 폰에서 만든 라벨이 여기서
  // 처음 보인다.
  loadLabels().catch(() => {})
}).catch((err) => {
  // 목록을 못 받아왔다. notesLoaded 가 서지 않으므로 [완료] 는 아무것도 내리지
  // 않는다 — 사용자가 이유를 알 수 있게 상태 줄에도 남긴다.
  // (syncNotes 는 스스로 실패를 삼키고 상태 줄에 남기므로 여기 오지 않는다.)
  listEl.textContent = ''
  showEmpty('메모 목록을 불러오지 못했습니다.')
  showToast(err && err.message ? err.message : '메모 목록을 불러오지 못했습니다.')
})
