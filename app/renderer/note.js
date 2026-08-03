'use strict'

const DEBOUNCE_MS = 1500
// 책갈피에 세로로 그릴 글자 수 상한. 넘치면 잘라낸다 — 화면 가장자리에 붙는
// 띠는 길어질 수 없고, 길어지면 아래 책갈피들을 밀어낸다.
const BOOKMARK_MAX_CHARS = 10
let noteId = null
let timer = null
// 서버에 마지막으로 반영된(또는 애초에 불러온) 제목/본문. title 입력칸과
// body 텍스트영역이 이제 Keep 의 두 필드를 각자 그대로 보여주므로(합치거나
// 쪼개지 않는다), 비교 기준도 두 값이다. "타이머가 걸려 있는가"가 아니라 이
// 값들과 title.value / body.value 가 다른가로 미저장 편집 유무를 판단한다 —
// 우클릭 후 취소처럼 타이머 없이도 미저장 편집이 남는 경로가 있기 때문이다.
let savedTitle = ''
let savedText = ''
// 이 메모가 체크리스트인가. Keep 의 노트는 Note 이거나 List 이고 둘 사이에 변환
// 경로가 없으므로(gkeepapi 의 type 에는 setter 도 convert* 도 없다) 이 값은 불러온
// 뒤로 바뀌지 않는다 — 창이 뜬 뒤에 종류가 달라지는 경로는 없다.
let isChecklist = false
// 체크리스트일 때, 서버에 마지막으로 반영된 항목 묶음의 서명(checklist-items.js).
// text 노트의 savedText 와 정확히 같은 자리에 있는 값이다: 미저장 편집이 있는가를
// 이것과 지금 화면의 서명을 견주어 판단한다.
let savedItemsSig = ''
// 지금 DOM 에 그려진 항목 줄들. { id, check, textInput, li } 의 배열이다.
// **항목 id 는 여기에만 있고 DOM 속성에는 심지 않는다** — Keep 의 식별자가 DOM 에
// 드러나는 표면을 최소로 둔다(목록 창의 renderedRows 와 같은 관례다).
let itemRows = []
// 본문을 실제로 Keep 에서 받아왔는가. 이 값이 false 인 동안 저장 경로는 완전히
// 닫혀 있다 — 비어 있는 본문으로 update_note 를 부르면 Keep 의 진짜 내용이
// 통째로 지워지고, Keep 에는 노트별 버전 기록이 없어 되돌릴 방법이 없다.
let loaded = false
// 지금 책갈피로 접혀 있는가. 이 값의 주인은 main 프로세스다 — 재시작 복원처럼
// 렌더러가 스스로 알 수 없는 경로가 있어서, 접힘 여부는 항상 통보로 받는다.
let folded = false
// 책갈피에 세로로 그릴 문구. 불러오기 전에 접힘 통보가 먼저 올 수 있으므로
// (재시작 복원) 따로 들고 있다가 둘 중 늦게 오는 쪽에서 다시 그린다.
let bookmarkText = ''

const title = document.getElementById('title')
const body = document.getElementById('body')
const itemList = document.getElementById('items')
const status = document.getElementById('status')
const badge = document.getElementById('badge')
const bookmark = document.getElementById('bookmark')
const bookmarkLabel = document.getElementById('bookmark-label')
const lookToggle = document.getElementById('lookToggle')
const lookPanel = document.getElementById('lookPanel')
const colorPicker = document.getElementById('colorPicker')
const deleteButton = document.getElementById('delete')
const fontFamilyEl = document.getElementById('note-font-family')
const fontTitleEl = document.getElementById('note-font-title-size')
const fontBodyEl = document.getElementById('note-font-body-size')

// 목록 창 [설정] 의 공통 서체. main 이 알려주고, 바뀔 때마다 다시 온다.
let globalFont = DEFAULT_FONT_SETTINGS
// 이 메모만의 재정의. null 이면 재정의 없음 = 공통 설정을 그대로 따른다.
// **공통 값을 복사해 두지 않는 것이 핵심이다** — 복사해 두면 공통 설정을
// 바꿨을 때 이 노트만 옛 값에 얼어붙는다. 합치는 규칙은 note-font.js 에 있다.
let noteFontOverride = null
// 휴지통 요청이 이미 하나 나가 있는가. 확인 대화상자를 두 번 띄우지 않는다.
let trashing = false

// Keep 이 실제로 지원하는 12색. 이름은 gkeepapi.node.ColorValue 의 멤버
// 이름과 정확히 같아야 한다 — 그래야 body.dataset.color 를 통해 note.html 의
// CSS 규칙과 맞물린다. 진짜 검증(이 12개가 전부인지)은 사이드카가 한다 —
// 여기서는 렌더러가 보여줄 스와치의 목록과 순서일 뿐이다.
const NOTE_COLORS = [
  ['White', '흰색'], ['Red', '빨강'], ['Orange', '주황'], ['Yellow', '노랑'],
  ['Green', '초록'], ['Teal', '청록'], ['Blue', '파랑'], ['DarkBlue', '남색'],
  ['Purple', '보라'], ['Pink', '분홍'], ['Brown', '갈색'], ['Gray', '회색']
]
// 색상 저장 요청이 이미 하나 나가 있는 동안 새 클릭을 무시한다. 없으면
// 스와치를 연달아 누를 때 응답이 뒤섞여 도착해 먼저 보낸 색이 나중 응답으로
// 덮어써질 수 있다.
let colorSaving = false

/**
 * 배지 툴팁에 보여줄 한 문자열을 만든다. 되돌리기용(왕복 보존) 데이터가
 * 아니라 사람이 읽을 요약일 뿐이므로, title 이 있으면 앞에 붙이고 없으면
 * text 만 보여주는 정도로 충분하다 — 저장은 항상 title/text 를 필드
 * 그대로 보내므로 이 문자열을 다시 나눌 일이 없다.
 */
function summarize (unsavedTitle, unsavedText) {
  return unsavedTitle ? `${unsavedTitle}\n${unsavedText}` : unsavedText
}

function showConflict (sentTitle, sentText) {
  badge.textContent = '다른 기기에서 수정됨 — 내 편집본은 보관되어 있습니다'
  badge.classList.add('show')
  badge.title = summarize(sentTitle, sentText)
}

function showSaveFailure (unsavedTitle, unsavedText) {
  // 다른 기기와의 충돌이 아니라 저장 자체(네트워크/재로그인/사이드카)가
  // 실패한 경우다. 같은 배지 UI 를 재사용하되 문구는 다르게 둔다 — 사용자가
  // "누군가 내 메모를 고쳤다"로 오해하면 안 된다. main 프로세스가 이미
  // conflictBackup 에 title/text 둘 다 저장했다.
  badge.textContent = '저장 실패 — 내 편집본은 보관되어 있습니다'
  badge.classList.add('show')
  badge.title = summarize(unsavedTitle, unsavedText)
}

/**
 * 지금 이 순간 입력칸에 있는 값으로 책갈피 문구를 뽑는다. 순수 로직(제목이
 * 있으면 제목, 없으면 본문 첫 줄)은 deriveBookmarkText 에 있다 — note.html 이
 * 이 스크립트보다 먼저 불러 전역에 건 함수다(bookmark-text.js 참고). 이
 * 함수가 하는 일은 그 순수 함수에 지금 DOM 값을 넘기는 것뿐이다.
 *
 * 저장 여부와 무관하게 항상 title.value / body.value 를 직접 읽는다. 저장된
 * (savedTitle/savedText) 값을 대신 썼다면, 막 제목을 치고 저장 전에 곧바로
 * 접었을 때 여전히 로드 시점의(또는 빈) 값이 나와 버린다 — 이 함수가 고치는
 * 버그가 바로 그것이다.
 */
function currentBookmarkText () {
  // 체크리스트에는 본문 textarea 가 없다. 제목이 비었을 때 책갈피에 보여줄
  // "본문"은 항목 글자를 이어 붙인 것이다 — 그러면 deriveBookmarkText 의 규칙
  // (제목이 없으면 본문 첫 줄)이 그대로 "첫 항목"이 된다.
  return deriveBookmarkText(title.value, isChecklist ? checklistText(currentItems()) : body.value)
}

// --- 체크리스트 ------------------------------------------------------------

/**
 * 지금 화면의 항목들을 사이드카가 받는 모양([{ id, text, checked }])으로 읽는다.
 * 저장할 때도, 미저장 편집을 판단할 때도, 책갈피 문구를 뽑을 때도 여기서 온다 —
 * text 노트에서 body.value 하나가 하던 역할이다.
 */
function currentItems () {
  return itemRows.map((row) => ({
    id: row.id,
    text: row.textInput.value,
    checked: row.check.checked
  }))
}

/**
 * 항목 줄들을 다시 그린다.
 *
 * 항목 글자는 Keep 에서 온 외부 데이터다. innerHTML 은 쓰지 않는다 —
 * createElement 로 만들고 값은 .value 로만 넣는다(책갈피의 renderBookmark 가
 * textContent 만 쓰는 것과 같은 이유다).
 *
 * 편집 잠금은 지금의 loaded 를 그대로 따른다. 불러오기가 끝나기 전에 그려지는
 * 경우(충돌 응답으로 다시 그리는 경우는 이미 loaded 다)에도 잠긴 채로 서고,
 * setEditingEnabled() 가 뒤이어 한꺼번에 연다.
 */
function renderChecklist (list) {
  itemRows = []
  itemList.textContent = ''
  for (const item of Array.isArray(list) ? list : []) {
    const li = document.createElement('li')

    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = item.checked === true
    check.disabled = !loaded

    const textInput = document.createElement('input')
    textInput.type = 'text'
    textInput.value = typeof item.text === 'string' ? item.text : ''
    textInput.spellcheck = false
    textInput.readOnly = !loaded

    const paintChecked = () => li.classList.toggle('checked', check.checked)
    paintChecked()

    // **체크 토글도 글자 편집도 같은 onEdit 을 지난다.** 그래서 같은 디바운스
    // 타이머 하나를 다시 걸 뿐이고, 연달아 여러 개를 체크해도 네트워크 요청은
    // 마지막 한 번으로 접힌다 — 본문 타이핑과 정확히 같은 방식이다.
    check.addEventListener('change', () => { paintChecked(); onEdit() })
    textInput.addEventListener('input', onEdit)

    li.append(check, textInput)
    itemList.append(li)
    itemRows.push({ id: item.id, check, textInput, li })
  }
}

/**
 * 미저장 편집이 있는가. ✕ / 접기 / 색 변경 / 마지막 flush 요청이 전부 이 하나를
 * 본다 — 두 종류의 메모에 대해 판단이 두 벌로 갈리면 한쪽만 고쳐지는 날이 온다.
 */
function hasUnsavedEdits () {
  if (title.value !== savedTitle) return true
  return isChecklist
    ? checklistSignature(currentItems()) !== savedItemsSig
    : body.value !== savedText
}

/**
 * 책갈피의 세로 글자를 다시 그린다. 한 줄에 한 글자씩, 최대 10 글자.
 * Keep 의 제목/본문은 외부 데이터이므로 innerHTML 을 쓰지 않고 글자마다
 * createElement + textContent 로 만든다.
 */
function renderBookmark () {
  // 줄바꿈·연속 공백은 한 칸으로 줄인다. 세로로 세우면 빈 줄이 그대로 낭비가
  // 되는데, 쓸 수 있는 줄이 10 개뿐이다.
  const text = (bookmarkText || '(제목없음)').replace(/\s+/g, ' ').trim() || '(제목없음)'
  bookmark.title = `${text} — 눌러서 펼치기`
  bookmarkLabel.textContent = ''
  // Array.from 은 코드 포인트 단위로 쪼갠다. slice(0, 10) 을 문자열에 바로
  // 쓰면 이모지 같은 서로게이트 쌍이 반 토막 나 깨진 글자가 남는다.
  for (const ch of Array.from(text).slice(0, BOOKMARK_MAX_CHARS)) {
    const line = document.createElement('span')
    line.textContent = ch
    bookmarkLabel.append(line)
  }
}

/** 접힘 상태에 맞춰 포스트잇 모습과 책갈피 모습을 갈아 끼운다. */
function applyFoldUI () {
  document.body.classList.toggle('folded', folded)
  if (folded) {
    renderBookmark()
    // 접히면 #lookPanel 은 CSS 로도 숨지만, 열어둔 채로 접었다가 다시
    // 펼치면 패널이 열린 채로 돌아오는 것도 어색하다. 접는 순간 닫는다.
    lookPanel.classList.remove('show')
  }
}

/**
 * 12개 스와치를 한 번만 만든다. Keep 색 이름은 여기서는 우리가 하드코딩한
 * 고정 목록이지 Keep 이 돌려준 데이터가 아니지만, 그래도 innerHTML 은 쓰지
 * 않고 createElement 로 만든다 — note.js 전체의 관례를 그대로 따른다.
 */
function buildColorPicker () {
  for (const [name, label] of NOTE_COLORS) {
    const swatch = document.createElement('button')
    swatch.type = 'button'
    swatch.className = 'swatch'
    swatch.dataset.color = name
    swatch.title = label
    swatch.setAttribute('aria-label', label)
    // 색 저장은 update_note 경로다. 본문을 아직(또는 영영) 못 받은 상태에서는
    // 열리면 안 된다 — selectColor 도 !loaded 면 돌아가지만, 눌리는데 아무 일도
    // 안 일어나는 것보다 눌리지 않는 편이 정직하다. 같은 패널의 서체는 Keep 을
    // 거치지 않으므로 이 잠금과 무관하게 계속 쓸 수 있다.
    swatch.disabled = true
    swatch.addEventListener('click', () => selectColor(name))
    colorPicker.append(swatch)
  }
}

/** 12개 스와치를 한꺼번에 열거나 잠근다. */
function setSwatchesEnabled (enabled) {
  for (const swatch of colorPicker.children) swatch.disabled = !enabled
}

/** 지금 노트의 색과 같은 이름의 스와치에 표시를 두른다. */
function markCurrentColor () {
  const current = document.body.dataset.color
  for (const swatch of colorPicker.children) {
    swatch.classList.toggle('current', swatch.dataset.color === current)
  }
}

/**
 * 스와치를 눌렀을 때. 화면은 곧장 바뀌고(낙관적 갱신), 저장은 뒤이어
 * update_note 로 나간다 — 실패하면 원래 색으로 되돌린다.
 *
 * 대기 중인 디바운스 저장이 있으면 색 변경보다 먼저 흘려보낸다. ✕/접기와
 * 똑같은 순서다: 여기서 먼저 flush() 하지 않으면, 타이핑 중이던 텍스트가
 * 아직 반영되지 않은 채로 색만 담은 update_note 가 먼저 나가고, 뒤이어
 * 디바운스 타이머가 뒤늦게 두 번째(별개의) 저장 요청을 걸어 두 요청의
 * 도착 순서가 보장되지 않는다. 반대로, 색 변경 응답으로 title.value/body.value
 * 나 savedTitle/savedText 를 절대 건드리지 않는다 — 이 요청은 title/text 를
 * 보내지 않았으므로(Python 쪽 둘 다 None) 응답에 실린 note.title/note.text 는
 * 그저 서버에 남아있던 값일 뿐이다. 그걸 그대로 반영하면 방금 흘려보낸(또는
 * 그 사이 사용자가 다시 친) 편집을 조용히 덮어쓸 수 있다.
 */
async function selectColor (name) {
  if (!loaded || colorSaving) return
  colorSaving = true
  // 예전에는 여기서 패널을 닫았다. 지금 이 패널에는 색 말고 서체도 들어 있어서
  // 색 하나 골랐다고 닫아 버리면 서체를 이어서 손보려던 사용자가 매번 다시
  // 열어야 한다. 고른 색은 패널 바깥의 노트 배경과 스와치의 표시로 이미 보인다.

  const previousColor = document.body.dataset.color
  document.body.dataset.color = name
  markCurrentColor()

  clearTimeout(timer)
  if (hasUnsavedEdits()) {
    await flush()
  }

  status.textContent = '색상 변경 중'
  const res = await window.keepSticky.updateNote(noteId, { color: name })
  if (!res.ok) {
    document.body.dataset.color = previousColor
    markCurrentColor()
    status.textContent = res.code === 'AUTH_REQUIRED' ? '재로그인 필요' : '색상 변경 실패'
    colorSaving = false
    return
  }
  document.body.dataset.color = res.note.color
  markCurrentColor()
  status.textContent = '저장됨'
  colorSaving = false
}

// --- 이 메모만의 서체 ------------------------------------------------------
//
// Keep 에는 서체 필드가 없다. 그래서 이 값은 Keep 이 아니라 state.json 의 이
// 노트 항목 안에 산다(x/y/w/h/visible/folded/conflictBackup 옆). update_note 로
// 나가지 않으므로 저장 실패도 충돌도 없고, 불러오기(loaded)와도 무관하다 —
// 메모 본문을 못 받아온 창에서도 서체는 고칠 수 있다.

/** 공통 설정 + 이 노트의 재정의를 합쳐 화면에 입힌다. */
function applyNoteFont () {
  applyFontSettings(resolveNoteFont(globalFont, noteFontOverride))
}

/**
 * 입력칸 셋을 지금 상태로 맞춘다.
 *
 * **빈 칸이 곧 "공통 설정 따름"이다.** 그래서 재정의가 없는 항목에는 값을 넣지
 * 않고, 대신 placeholder 로 공통 값이 몇인지 보여준다. 여기에 공통 값을 실제
 * value 로 채워 넣으면 사용자가 아무것도 안 했는데도 change 한 번에 그 값이
 * 재정의로 굳어 버린다 — 그러면 나중에 공통 설정을 바꿔도 이 노트만 안 따라온다.
 */
function showNoteFontInputs () {
  const ov = noteFontOverride || {}
  fontFamilyEl.value = ov.family === undefined ? '' : ov.family
  fontTitleEl.value = ov.titlePt === undefined ? '' : String(ov.titlePt)
  fontBodyEl.value = ov.bodyPt === undefined ? '' : String(ov.bodyPt)
  fontTitleEl.placeholder = String(globalFont.titlePt)
  fontBodyEl.placeholder = String(globalFont.bodyPt)
}

function readNoteFontInputs () {
  // 빈 문자열은 note-font.js 에서 그대로 "재정의 아님"으로 떨어진다 — 글꼴은
  // 표에 없는 key 라서, 크기는 숫자로 읽히지 않아서다.
  return { family: fontFamilyEl.value, titlePt: fontTitleEl.value, bodyPt: fontBodyEl.value }
}

/**
 * 고른 값을 화면에 입히고 저장한다. 목록 창의 saveFontSettings 와 같은 순서다:
 * 먼저 입혀 반응을 즉시 보여주고, 저장 결과(=검증을 지난 값)가 오면 그것으로 한
 * 번 더 맞춘다 — 999 를 넣었다면 입력칸도 조인 값으로 바뀌어야 한다.
 */
async function saveNoteFont (raw) {
  // noteId 를 아직 모르면 저장할 곳이 없다. 이 창이 어느 메모인지 모르는 채로
  // 쓰면 남의 메모 설정을 건드릴 수 있다.
  if (!noteId) return
  noteFontOverride = normalizeNoteFontOverride(raw)
  applyNoteFont()
  showNoteFontInputs()
  const saved = await window.keepSticky.setNoteFont(noteId, noteFontOverride)
  noteFontOverride = saved || null
  applyNoteFont()
  showNoteFontInputs()
}

/**
 * 글꼴 <option> 과 크기 입력칸의 범위를 만든다. 목록 창과 같은 표(FONT_CHOICES)
 * 와 같은 범위(FONT_PT_RANGE)를 쓴다 — 여기서 다시 적지 않는다.
 *
 * 맨 앞의 빈 값 항목이 "재정의 없음"이다. 이것이 곧 되돌리는 방법이기도 하다
 * (아래 [공통 설정 따르기] 는 셋을 한 번에 되돌린다).
 */
function buildNoteFontChoices () {
  const follow = document.createElement('option')
  follow.value = ''
  follow.textContent = '공통 설정 따름'
  fontFamilyEl.append(follow)
  for (const choice of FONT_CHOICES) {
    const opt = document.createElement('option')
    opt.value = choice.key
    opt.textContent = choice.label
    fontFamilyEl.append(opt)
  }
  for (const el of [fontTitleEl, fontBodyEl]) {
    el.min = String(FONT_PT_RANGE.min)
    el.max = String(FONT_PT_RANGE.max)
  }
}

// 숫자 칸은 input 이 아니라 change(칸을 벗어나거나 Enter)에서 반영한다. 매
// 글자마다 반영하면 "1" 을 친 순간 6 으로 조여져 "12" 를 칠 수가 없다.
// (목록 창의 [설정] 과 같은 이유, 같은 방식이다.)
fontFamilyEl.addEventListener('change', () => { saveNoteFont(readNoteFontInputs()).catch(() => {}) })
fontTitleEl.addEventListener('change', () => { saveNoteFont(readNoteFontInputs()).catch(() => {}) })
fontBodyEl.addEventListener('change', () => { saveNoteFont(readNoteFontInputs()).catch(() => {}) })
document.getElementById('note-font-reset').addEventListener('click', () => {
  // null 을 보내면 재정의가 통째로 지워진다 — 그 뒤로 이 노트는 공통 설정을
  // 실시간으로 따른다.
  saveNoteFont(null).catch(() => {})
})

function showLoadFailure (message) {
  // 배지를 재사용하되 문구는 다르다. 이건 충돌도 저장 실패도 아니고 "아직 아무
  // 것도 못 받았다"는 상태다. 사용자가 여기에 타이핑할 수 있으면 안 된다.
  badge.textContent = `메모를 불러오지 못했습니다 — 편집이 잠겨 있습니다: ${message}`
  badge.classList.add('show')
  badge.title = message
  status.textContent = '불러오기 실패'
}

/**
 * 체크리스트의 저장. 아래 flush() 의 체크리스트 갈래이고, 모양은 그쪽과 같다:
 * 실패하면 배지로 알리고(편집본은 main 이 conflictBackup 에 보관한다), 충돌이면
 * 서버가 이긴 내용을 화면에 반영한다.
 *
 * 제목과 항목을 **한 번의 요청**으로 같이 보낸다. 두 번으로 쪼개면 둘의 도착
 * 순서가 보장되지 않고, 하나만 성공하는 반쯤 저장된 상태가 생긴다.
 */
async function flushChecklist (attemptTitle) {
  const attemptItems = currentItems()
  const res = await window.keepSticky.updateChecklist(noteId, {
    title: attemptTitle, items: attemptItems
  })
  if (!res.ok) {
    // 배지 툴팁에는 사람이 읽을 요약을 넣는다. 되돌리기용 데이터가 아니다 —
    // 진짜 보관본은 main 이 state.json 의 conflictBackup 에 { title, items } 로
    // 넣어 두었고, 그쪽에는 항목마다 id/text/checked 가 전부 남아 있다.
    showSaveFailure(attemptTitle, checklistText(attemptItems))
    status.textContent = res.code === 'AUTH_REQUIRED' ? '재로그인 필요' : '저장 실패 — 편집본 보관됨'
    return
  }
  if (res.conflict) {
    showConflict(attemptTitle, checklistText(attemptItems))
    title.value = res.note.title || '' // 서버가 이긴 내용을 보여준다
    renderChecklist(res.note.items)
    savedTitle = title.value
    savedItemsSig = checklistSignature(currentItems())
    bookmarkText = currentBookmarkText()
  } else {
    badge.classList.remove('show')
    savedTitle = attemptTitle
    savedItemsSig = checklistSignature(attemptItems)
  }
  status.textContent = '저장됨'
}

async function flush () {
  // 불러오지 못한(또는 아직 못 불러온) 본문으로는 절대 저장하지 않는다.
  // 이 한 줄이 "빈 포스트잇에 한 글자 → Keep 메모 전체가 그 한 글자로 교체"
  // 를 막는 마지막 방어선이다. 체크리스트에서도 똑같이 필요하다 — 항목을 하나도
  // 못 받은 채로 빈 묶음을 보내면 그것이 곧 "전부 지우기"다.
  if (!loaded) return
  // title/text 는 각자의 입력칸에서 그대로 온다 — 합치거나 쪼갤 필요가 없다.
  // 두 필드는 이미 Keep 이 저장할 두 필드 그 자체다.
  const attemptTitle = title.value
  if (isChecklist) {
    status.textContent = '저장 중'
    await flushChecklist(attemptTitle)
    return
  }
  const attemptText = body.value
  status.textContent = '저장 중'
  const res = await window.keepSticky.updateNote(noteId, { title: attemptTitle, text: attemptText })
  if (!res.ok) {
    // notes:update 는 이제 실패해도 거절(reject)하지 않고 { ok:false } 로
    // 응답한다 — ipcMain.handle 이 던지면 err.code 가 IPC 경계를 못 건너오기
    // 때문이다. 사용자가 친 내용은 이미 main 프로세스가 conflictBackup 으로
    // title/text 둘 다 보관했으니 여기서는 알리기만 한다.
    showSaveFailure(attemptTitle, attemptText)
    status.textContent = res.code === 'AUTH_REQUIRED' ? '재로그인 필요' : '저장 실패 — 편집본 보관됨'
    return
  }
  if (res.conflict) {
    // 배지 툴팁에는 방금 보낸 title/text 그대로 — 사용자가 화면에서 실제로
    // 보고 있던 값이다.
    showConflict(attemptTitle, attemptText)
    title.value = res.note.title || '' // 서버가 이긴 내용을 보여준다
    body.value = res.note.text || ''
    savedTitle = title.value
    savedText = body.value
    bookmarkText = currentBookmarkText() // 서버 쪽 내용으로 책갈피 문구도 다시 뽑는다
  } else {
    badge.classList.remove('show')
    savedTitle = attemptTitle
    savedText = attemptText
  }
  status.textContent = '저장됨'
}

/** 제목/본문 어느 쪽이든 편집하면 같은 디바운스 타이머를 다시 건다 —
 * 두 필드가 경쟁하는 별개의 타이머를 갖지 않는다. */
function onEdit () {
  status.textContent = ''
  // 저장 여부와 무관하게 지금 값으로 책갈피 문구를 즉시 갱신한다 — 저장
  // 왕복을 기다리지 않아야 "치자마자 접기"에서도 방금 친 제목이 보인다.
  bookmarkText = currentBookmarkText()
  clearTimeout(timer)
  timer = setTimeout(flush, DEBOUNCE_MS)
}
title.addEventListener('input', onEdit)
body.addEventListener('input', onEdit)

// 제목 칸에서 Enter 는 아무것도 저장/제출하지 않고 본문으로 포커스만 옮긴다.
// <input type="text"> 는 애초에 줄바꿈을 넣을 수 없으므로(제목에 줄바꿈이
// 없다는 규칙을 컨트롤 자체가 강제한다) 여기서 막을 "제출"은 없지만, 감싸는
// <form> 이 없어도 브라우저마다 Enter 처리가 다를 수 있어 명시적으로 막는다.
title.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  body.focus()
})

document.getElementById('close').addEventListener('click', async () => {
  // 디바운스 타이머를 먼저 끊는다 — 곧이어 flush() 를 직접 부르므로,
  // 남은 타이머가 뒤늦게 두 번째 저장을 걸지 않게 한다.
  clearTimeout(timer)
  // "타이머가 걸려 있었는가"는 미저장 편집의 정확한 신호가 아니다 (우클릭 →
  // 취소 경로는 타이머 없이도 미저장 편집을 남긴다). 실제로 서버에 반영된
  // 마지막 제목/본문과 다른지로 판단한다 — 둘 중 하나만 바뀌어도 미저장이다.
  // (체크리스트에서는 '본문' 자리에 항목 묶음의 서명이 들어간다. 판단은
  // hasUnsavedEdits 한 곳에만 있다.)
  if (hasUnsavedEdits()) {
    // flush() 는 실패해도 거절하지 않는다 — 실패하면 conflictBackup 에 이미
    // 보관한 뒤 돌아오므로, 성공 여부와 무관하게 닫아도 편집을 잃지 않는다.
    // 여기서 닫기를 막으면 사용자가 닫을 수 없는 창에 갇히므로 막지 않는다.
    await flush()
  }
  window.keepSticky.closeNote(noteId)
})

document.getElementById('fold').addEventListener('click', async () => {
  // ✕ 와 완전히 같은 순서다. 접기는 창을 44px 짜리 띠로 줄이므로 편집 화면이
  // 사라진다 — 여기서 먼저 저장하지 않으면 디바운스 대기 중이던 편집이
  // 조용히 사라진다. 타이머부터 끊어 뒤늦은 두 번째 저장을 막는다.
  clearTimeout(timer)
  if (loaded && hasUnsavedEdits()) {
    // flush() 는 실패해도 거절하지 않는다. 실패분은 main 이 conflictBackup 에
    // 보관하고 배지를 띄운다 — 배지는 DOM 에 그대로 남아 펼치면 다시 보인다.
    await flush()
  }
  await window.keepSticky.foldNote(noteId)
})

// 책갈피를 누르면 접기 직전의 위치와 크기 그대로 돌아온다. 좌표는 main 이
// state.json 에 들고 있으므로 렌더러는 요청만 한다.
bookmark.addEventListener('click', () => window.keepSticky.unfoldNote(noteId))

// 저장된 설정을 IPC 로 읽어오기 전에 기본값을 먼저 입힌다(목록 창과 같다).
// note.html 의 :root 는 list.html / setup-email.html 과 같은 값을 유지해야
// 하므로, "기본 서체로 첫 그림을 그리는 일"은 CSS 가 아니라 여기서 한다.
applyNoteFont()

// [모양] 패널은 정적 UI 라 노트를 불러오기 전에 미리 만들어 둔다. 여는/닫는
// 것과 실제로 고를 수 있는 것은 별개다 — [모양] 버튼은 이 창이 어느 메모인지
// 알기 전까지(noteId 를 받기 전까지) disabled 로 막혀 있고(HTML 기본값), 그
// 안의 색 스와치는 본문을 불러오기 전까지 따로 더 막혀 있다.
buildColorPicker()
buildNoteFontChoices()
showNoteFontInputs()
lookToggle.addEventListener('click', () => {
  lookPanel.classList.toggle('show')
  if (lookPanel.classList.contains('show')) markCurrentColor()
})

// 접힘 여부는 main 이 정하고 알려준다. 창이 뜬 직후에도 한 번 오므로 재시작
// 복원(지난 세션에 접힌 채 끝난 메모)에서도 책갈피 모습으로 그려진다.
window.keepSticky.onFoldState((next) => {
  folded = next
  applyFoldUI()
})

// 목록 창 [설정] 의 공통 서체. 저장된 값을 한 번 읽고, 그 뒤로는 바뀔 때마다
// 통보로 받는다.
//
// **이 통보 하나가 "재정의 없는 노트는 공통 설정을 실시간으로 따른다"를
// 만든다.** 여기서 하는 일은 globalFont 를 갈아 끼우고 다시 입히는 것뿐이고,
// 재정의가 있는 항목은 resolveNoteFont 가 그대로 지켜준다 — 즉 글꼴만 재정의한
// 노트에서 공통 본문 크기를 바꾸면 글꼴은 그대로 두고 크기만 따라온다.
// placeholder 도 다시 그려 공통 값이 몇으로 바뀌었는지 보이게 한다.
window.keepSticky.getFontSettings().then((settings) => {
  globalFont = normalizeFontSettings(settings)
  applyNoteFont()
  showNoteFontInputs()
}).catch(() => {})

window.keepSticky.onFontSettings((settings) => {
  globalFont = normalizeFontSettings(settings)
  applyNoteFont()
  showNoteFontInputs()
})

/** 편집과 색 변경(= Keep 으로 나가는 모든 것)을 한꺼번에 잠그거나 연다. */
function setEditingEnabled (enabled) {
  loaded = enabled
  title.readOnly = !enabled
  body.readOnly = !enabled
  // 체크리스트의 줄들도 같이 잠근다. 여기를 빼먹으면 불러오지 못한 창에서
  // 체크를 눌러 빈 묶음이 저장되는 길이 열린다 — 그것이 곧 항목 전부 지우기다.
  // (체크상자는 readOnly 를 지원하지 않으므로 disabled 를 쓴다.)
  for (const row of itemRows) {
    row.check.disabled = !enabled
    row.textInput.readOnly = !enabled
  }
  setSwatchesEnabled(enabled)
  deleteButton.disabled = !enabled
}

// --- 본문의 URL 을 Ctrl+클릭으로 열기 ---------------------------------------

// 열지 못한 이유를 사람이 읽을 문구로 옮긴다. **아무 일도 일어나지 않는 것이
// 제일 나쁘다** — 사용자는 기능이 고장 났다고 읽는다. 거절도 결과이므로 알린다.
const URL_REFUSAL_MESSAGE = {
  EMPTY: '여기에는 주소가 없습니다',
  NOT_A_STRING: '여기에는 주소가 없습니다',
  UNPARSABLE: '주소로 읽을 수 없습니다',
  HAS_WHITESPACE: '주소로 읽을 수 없습니다',
  BLOCKED_PROTOCOL: 'http / https 주소만 열 수 있습니다'
}

/**
 * 캐럿이 놓인 자리의 주소를 기본 브라우저로 연다.
 *
 * 여기서 하는 검사는 **안내를 위한 것**이다. 진짜 검증은 main 프로세스의
 * shell:openExternal 핸들러가 같은 sanitizeUrl 로 다시 한다 — 렌더러는 신뢰
 * 경계의 바깥쪽이라 이쪽 검사만으로는 검사가 아니다.
 */
async function openUrlAtCaret () {
  const found = urlAtCaret(body.value, body.selectionStart)
  if (!found.ok) {
    status.textContent = URL_REFUSAL_MESSAGE[found.reason] || '열 수 있는 주소가 아닙니다'
    return
  }
  status.textContent = '브라우저에서 여는 중'
  const res = await window.keepSticky.openExternal(found.url)
  // main 이 거절할 수도 있다(렌더러를 통과했더라도). 그때도 조용히 끝내지 않는다.
  status.textContent = res && res.ok
    ? '브라우저에서 열었습니다'
    : (URL_REFUSAL_MESSAGE[res && res.code] || '주소를 열지 못했습니다')
}

// textarea 에는 링크 요소가 없으므로 누를 대상도, 꾸밀 것도 없다. 대신 클릭이
// 캐럿을 옮긴다는 사실을 쓴다 — click 이 오는 시점에는 selectionStart 가 이미
// 눌린 자리로 옮겨져 있다. preventDefault 는 부르지 않는다: 캐럿 이동은 이미
// 끝났고, 여기서 기본 동작을 막아 봐야 얻을 것이 없다.
//
// 평범한 클릭이 아니라 Ctrl+클릭인 이유가 이것이다. 평범한 클릭은 여전히 글자
// 사이에 커서를 놓는 본래의 일을 해야 한다. (macOS 를 위해 metaKey 도 같이
// 받는다 — 이 앱은 지금 Windows 전용이지만 한 줄로 끝나는 배려다.)
body.addEventListener('click', (e) => {
  if (!e.ctrlKey && !e.metaKey) return
  openUrlAtCaret()
})

/**
 * 이 메모를 Keep 휴지통으로 보내고(성공하면 main 이 창을 닫는다) 목록 창까지
 * 갱신되게 한다.
 *
 * **상단 바의 [삭제] 와 우클릭이 둘 다 이 함수 하나만 부른다.** 두 벌로 나뉘면
 * 한쪽만 고쳐지는 날이 온다.
 *
 * 지우기는 언제나 node.trash() 다 — Keep 휴지통으로 보내는 것이고 7일 안에
 * 복구할 수 있다. node.delete()(영구 삭제)로 가는 길은 이 앱 어디에도 없다.
 * ✕(closeNote)와 목록 창의 체크 해제는 이 함수를 부르지 않는다.
 */
async function trashCurrentNote () {
  // 접힌 책갈피 위에서는 열지 않는다. 44px 짜리 띠 위의 우클릭은 빗나가기 쉽고,
  // 그 끝에 있는 것이 되돌리기 어려운 동작이다. 지우려면 먼저 펼쳐서 어떤
  // 메모인지 보게 한다. ([삭제] 버튼은 접히면 상단 바째로 숨는다.)
  if (folded) return
  // 이미 한 번 보냈으면 대화상자를 또 띄우지 않는다.
  if (trashing) return
  // 불러오지 못한 메모는 지우지 않는다. 무엇을 지우는지 화면에 보이지 않는
  // 상태이고, 목록에 없는 id 일 수도 있다(그 경우 이미 사라진 메모다).
  if (!loaded) return
  // confirm() 이 렌더러의 유일한 JS 스레드를 막고 있는 동안 디바운스 타이머가
  // 기한을 넘기면, 스레드가 풀리는 순간(대화상자가 닫히자마자) 그 콜백이
  // trash_note 보다 먼저 또는 뒤에 끼어들어 update_note 와 trash_note 가
  // 순서 보장 없이 경합할 수 있다. close 핸들러처럼 여기서도 제일 먼저
  // 타이머를 끊는다.
  clearTimeout(timer)
  if (!confirm('정말로 삭제하시겠습니까?\n\nKeep 휴지통으로 보냅니다. 7일 안에는 Keep 에서 복구할 수 있습니다.')) return

  trashing = true
  // 저장 경로를 **요청을 보내기 전에** 잠근다. 이 순서가 중요하다: trash 가
  // 성공하면 main 이 곧바로 창을 닫는데, 그 닫기 경로가 렌더러에 마지막 flush
  // 를 요청한다(notes:flush). 그 요청은 지금 이 await 가 풀리기 전에 도착한다 —
  // 같은 IPC 파이프이고 main 이 먼저 보냈기 때문이다. 잠그는 것이 나중이면
  // 방금 버린 메모로 update_note 가 한 번 날아가고, 그 실패분이 state.json 의
  // conflictBackup 에 남는다. 존재하지 않는 메모의 본문이 디스크에 남는 셈이다.
  // (main 에도 같은 것을 막는 가드가 하나 더 있다.)
  //
  // 미저장 편집은 일부러 저장하지 않는다. 지우려는 메모다.
  setEditingEnabled(false)
  lookPanel.classList.remove('show')

  status.textContent = '휴지통으로 보내는 중'
  const res = await window.keepSticky.trashNote(noteId)
  if (!res.ok) {
    // 실패하면 main 프로세스가 창을 닫지 않으므로 메모와 창은 그대로다. 잠갔던
    // 편집을 되돌려 놓는다 — 안 그러면 사용자가 아무것도 못 하는 창에 갇힌다.
    // 사용자가 "휴지통으로 보냈다"고 착각하지 않도록 이유도 알린다.
    setEditingEnabled(true)
    trashing = false
    status.textContent = res.code === 'AUTH_REQUIRED' ? '재로그인 필요' : '휴지통 이동 실패'
    return
  }
  // 여기서부터는 main 이 창을 닫는다. 잠금은 그대로 둔다.
  status.textContent = '휴지통으로 보냈습니다'
}

deleteButton.addEventListener('click', () => { trashCurrentNote() })
document.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  // 위 [삭제] 버튼과 똑같은 경로다. 여기에 두 번째 구현을 두지 않는다.
  trashCurrentNote()
})

// 메인 프로세스가 창을 닫기 직전에 부른다 (Alt+F4·종료 등 ✕ 를 거치지 않는
// 경로 포함). 저장할 게 없으면 곧바로 끝났다고 알린다 — 메인은 유한한 시간만
// 기다리므로 어떤 경로로든 반드시 응답해야 한다.
window.keepSticky.onFlushRequest(async () => {
  clearTimeout(timer)
  try {
    if (loaded && hasUnsavedEdits()) await flush()
  } finally {
    window.keepSticky.flushDone()
  }
})

window.keepSticky.noteId().then(async (id) => {
  // id 는 ✕(닫기)에도 필요하므로 먼저 잡는다. 불러오기가 실패해도 사용자가
  // 창을 내릴 수는 있어야 한다. 저장 경로를 여는 것은 이 id 가 아니라 아래의
  // loaded / readOnly 다.
  noteId = id
  // 서체 재정의는 state.json 에만 있고 Keep 을 거치지 않는다. 그래서 아래
  // list_notes 를 기다리지 않고 따로 읽어 곧바로 입힌다 — 불러오기가 실패해
  // 편집이 잠긴 창에서도 글자 크기는 고칠 수 있어야 한다. 그래서 await 로
  // 묶지 않는다(묶으면 이 왕복만큼 본문 표시가 늦어진다).
  lookToggle.disabled = false
  window.keepSticky.getNoteFont(id).then((override) => {
    noteFontOverride = override || null
    applyNoteFont()
    showNoteFontInputs()
  }).catch(() => {})
  status.textContent = '불러오는 중'
  const { notes } = await window.keepSticky.listNotes()
  const note = notes.find((n) => n.id === id)
  // 목록에 없는 id 도 실패다. 여기서 빈 문자열로 폴백하면 그게 곧 원본 삭제다.
  if (!note) throw new Error('목록에서 이 메모를 찾지 못했습니다')
  // Keep 의 title/text 를 각 입력칸에 그대로 옮긴다 — 합치지 않는다. 왕복이
  // 걱정될 이유가 없다: 저장도 이 두 필드를 그대로 되돌려 보낼 뿐이다.
  title.value = note.title || ''
  savedTitle = title.value

  // 제목 칸은 두 종류 모두에 있다. 갈라지는 것은 그 아래다.
  //
  // kind 는 사이드카가 실어 준다("note" 또는 "list"). 이 값은 창의 수명 동안
  // 바뀌지 않는다 — Keep 의 노트는 Note 이거나 List 이고 둘 사이에 변환 경로가
  // 없기 때문이다(gkeepapi 의 type 에는 setter 도 convert* 도 없다). 그래서
  // 여기서 한 번 정하고 나면 종류를 다시 확인할 자리가 없다.
  isChecklist = note.kind === 'list'
  body.hidden = isChecklist
  itemList.hidden = !isChecklist
  if (isChecklist) {
    renderChecklist(note.items)
    savedItemsSig = checklistSignature(currentItems())
  } else {
    body.value = note.text || ''
    savedText = body.value
  }
  // Keep 의 색 이름을 그대로 속성 값으로 심는다 (innerHTML 경로가 아니다).
  // note.html 에 없는 이름이면 어느 규칙에도 안 걸려 기본 노란색이 남는다.
  if (note.color) document.body.dataset.color = note.color
  markCurrentColor()
  bookmarkText = currentBookmarkText()
  // 여기가 편집이 열리는 유일한 지점이다. 색 변경([모양] 패널의 스와치)과
  // [삭제] 도 같이 열린다 — 둘 다 "이 메모를 실제로 받아왔다"를 전제로 한다.
  setEditingEnabled(true)
  status.textContent = ''
  // 접힘 통보가 불러오기보다 먼저 왔을 수 있다(재시작 복원). 이제 제목을
  // 알았으니 책갈피 글자를 제대로 다시 그린다.
  applyFoldUI()
}).catch((err) => {
  showLoadFailure(err && err.message ? err.message : String(err))
  applyFoldUI()
})
