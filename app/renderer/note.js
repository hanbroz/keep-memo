'use strict'

const DEBOUNCE_MS = 1500
// 이어 친 글자를 되돌리기 한 단계로 묶어 두는 시간. 이만큼 손을 멈추면 다음
// 글자부터는 새 단계다 — 글자마다 한 단계씩 쌓으면 Ctrl+Z 스무 번이 낱말 하나를
// 지우고, 반대로 영영 묶어 두면 한 번에 문단 전체가 날아간다.
const TYPING_GROUP_MS = 1200
// 책갈피에 세로로 그릴 글자 수 상한. 넘치면 잘라낸다 — 화면 가장자리에 붙는
// 띠는 길어질 수 없고, 길어지면 아래 책갈피들을 밀어낸다.
const BOOKMARK_MAX_CHARS = 10
let noteId = null
let timer = null
// 서버에 마지막으로 반영된(또는 애초에 불러온) 제목/본문. title 입력칸과 본문
// 편집기가 Keep 의 두 필드를 각자 그대로 보여주므로(합치거나 쪼개지 않는다),
// 비교 기준도 두 값이다. "타이머가 걸려 있는가"가 아니라 이 값들과
// title.value / currentBodyText() 가 다른가로 미저장 편집 유무를 판단한다 —
// 우클릭 후 취소처럼 타이머 없이도 미저장 편집이 남는 경로가 있기 때문이다.
let savedTitle = ''
let savedText = ''
// 이 메모가 폰에서 만든 **진짜 Keep List** 인가. Keep 의 노트는 Note 이거나
// List 이고 둘 사이에 변환 경로가 없으므로(gkeepapi 의 type 에는 setter 도
// convert* 도 없다) 이 값은 불러온 뒤로 바뀌지 않는다.
//
// 이 앱이 새로 만드는 메모는 언제나 text 노트다. 체크리스트는 이제 본문 안의
// 텍스트 규약이기 때문이다(line-model.js). 그래도 사용자의 Keep 계정에는 폰에서
// 만든 List 노트가 이미 있을 수 있고, 그것도 열려서 쓸 수 있어야 한다 — 같은
// 편집기에 그리되 저장은 항목 id 를 쓰는 update_checklist 로 나간다.
let isNativeList = false
// 진짜 List 노트일 때, 서버에 마지막으로 반영된 항목 묶음의 서명
// (checklist-items.js). text 노트의 savedText 와 정확히 같은 자리에 있는 값이다.
let savedItemsSig = ''
// 본문의 줄 모형. { kind, checked, text } 의 배열이고, 진짜 List 노트에서는
// 줄마다 Keep 항목 id 가 .id 로 하나 더 붙는다.
//
// **항목 id 는 여기에만 있고 DOM 속성에는 심지 않는다** — Keep 의 식별자가 DOM 에
// 드러나는 표면을 최소로 둔다(목록 창의 renderedRows 와 같은 관례다).
let noteLines = []
// 지금 DOM 에 그려진 줄들. { el, check, input } 의 배열이고 noteLines 와 자리
// (인덱스)로 짝을 이룬다.
let lineRows = []
// 되돌리기/다시 하기 기록(undo-stack.js). 불러오기가 끝나야 생긴다.
let undoHistory = null
// 캐럿이 마지막으로 있던 줄. [체크] 버튼처럼 포커스 밖에서 오는 명령이 "지금
// 이 줄"을 알아내는 자리다.
let focusedLine = 0
// 이어 친 글자를 한 묶음으로 만드는 열쇠의 세대 번호. TYPING_GROUP_MS 만큼
// 쉬거나, 다른 줄로 옮기거나, 줄을 더하고 지우면 세대가 올라가 묶음이 끊긴다.
let typingGroup = 0
let typingGroupTimer = null
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
const lineToggle = document.getElementById('lineToggle')
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
 * 저장 여부와 무관하게 항상 지금 화면의 값을 직접 읽는다. 저장된
 * (savedTitle/savedText) 값을 대신 썼다면, 막 제목을 치고 저장 전에 곧바로
 * 접었을 때 여전히 로드 시점의(또는 빈) 값이 나와 버린다 — 이 함수가 고치는
 * 버그가 바로 그것이다.
 */
function currentBookmarkText () {
  // 책갈피에는 표식을 뗀 글자를 넘긴다. "- [ ] 우유" 가 세로로 서면 쓸 수 있는
  // 열 칸 중 여섯 칸이 표식으로 낭비된다.
  return deriveBookmarkText(title.value, currentPlainText())
}

// --- 본문: 줄 단위 편집기 ---------------------------------------------------
//
// 본문은 줄의 배열(noteLines)이고, 줄마다 자기 입력칸이 있다(lineRows).
// 줄 하나는 평범한 글이거나 체크리스트 항목이며, 한 메모 안에서 마음대로 섞인다.
// Keep 으로 나갈 때는 line-model.js 의 규약대로 다시 한 덩어리 텍스트가 된다.
//
// **왜 본문 전체가 <textarea> 하나가 아닌가**: textarea 는 균일하게 그린다.
// 그 안의 한 줄에만 체크박스를 놓거나 취소선을 그을 방법이 없다.
// **왜 contenteditable 이 아닌가**: 한글 IME 조합 중에 캐럿이 튀고 글자가
// 사라진다. 이 프로젝트가 두 번 물러난 길이고, 제목이 별도 <input> 이 된 것도
// 같은 이유다. 폼 컨트롤 안에서는 IME 가 정상으로 동작한다.
// **왜 줄마다 <input> 이 아니라 한 줄짜리 <textarea> 인가**: <input> 은 접히지
// 않는다. 320px 포스트잇에서 긴 한국어 문장이 옆으로 밀려 나가면 읽을 수가
// 없다. 높이는 growLine() 이 내용에 맞춰 맞춘다.
//
// 대가도 분명하다: 선택 영역이 줄을 넘지 못한다(여러 줄을 한 번에 끌어 선택하거나
// 복사할 수 없다). 캐럿 이동만이라도 한 편의 글처럼 느껴지게 아래 키 처리가
// 위/아래/좌/우를 줄 사이로 이어 준다.

/** 지금 줄들을 Keep 에 보낼 본문 한 덩어리로 만든다. */
function currentBodyText () {
  return serializeNoteLines(noteLines)
}

/** 사람에게 보여줄 본문(표식을 뗀 글자). 책갈피와 배지 요약이 쓴다. */
function currentPlainText () {
  return noteLinesPlainText(noteLines)
}

/**
 * 지금 줄들을 사이드카가 받는 항목 모양([{ id, text, checked }])으로 읽는다.
 * **폰에서 만든 진짜 List 노트에서만 쓴다** — 그쪽은 줄을 더하거나 뺄 수 없으므로
 * 줄과 Keep 항목이 언제나 자리까지 1:1 이다.
 */
function currentItems () {
  return noteLines.map((line) => ({
    id: line.id,
    text: line.text,
    checked: line.checked === true
  }))
}

/**
 * 줄 하나를 내용에 맞는 높이로 맞춘다.
 *
 * 한 줄짜리 textarea 라도 글이 길면 접혀서 두 줄, 세 줄이 된다. 높이를
 * 내버려 두면 안쪽에 스크롤막대가 생겨 뒷부분이 안 보인다 — 320px 포스트잇에서
 * 제일 흔한 모양이 바로 접힌 줄이다.
 *
 * 'auto' 로 한 번 되돌린 뒤 scrollHeight 를 읽는 순서가 중요하다. 그러지 않으면
 * 글을 지웠을 때 높이가 줄지 않는다(scrollHeight 는 현재 height 보다 작아지지
 * 않는다).
 */
function growLine (input) {
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
}

/** 모든 줄의 높이를 다시 맞춘다. 서체가 바뀌거나 창 너비가 바뀌면 다시 접힌다. */
function growAllLines () {
  for (const row of lineRows) growLine(row.input)
}

/**
 * 이 줄이 접히지 않은(시각적으로 한 줄인) 상태인가.
 *
 * 위/아래 화살표를 어떻게 다룰지가 여기서 갈린다. 접히지 않은 줄에서는 곧바로
 * 윗줄/아랫줄로 건너뛰는 것이 맞고(한 편의 글처럼), 접힌 줄에서는 브라우저가
 * 그 안에서 시각적 줄을 오르내리게 두어야 한다.
 */
function isSingleVisualRow (input) {
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight)
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return true
  return input.scrollHeight < lineHeight * 1.5
}

/** 줄 하나의 DOM 을 만든다. 글자는 Keep 에서 온 외부 데이터라 .value 로만 넣는다. */
function buildLineRow (line) {
  const el = document.createElement('div')
  el.className = 'line'
  let check = null
  if (line.kind === 'item') {
    check = document.createElement('input')
    check.type = 'checkbox'
    check.className = 'line-check'
    check.checked = line.checked === true
    check.disabled = !loaded
    if (line.checked === true) el.classList.add('checked')
    el.append(check)
  }
  const input = document.createElement('textarea')
  input.className = 'line-text'
  input.rows = 1
  input.spellcheck = false
  input.readOnly = !loaded
  input.value = line.text
  el.append(input)
  return { el, check, input }
}

/**
 * 줄들을 통째로 다시 그린다.
 *
 * 통째로 그리는 이유: 줄이 늘거나 줄거나 종류가 바뀌면 그 아래 모든 줄의 자리가
 * 밀린다. 부분 갱신은 그 자리 계산을 두 번째 진실로 만들고, 두 진실은 언젠가
 * 어긋난다. 포스트잇의 줄 수는 수십 줄이라 통째로 그려도 사람이 느낄 만한
 * 비용이 아니다. (글자만 치는 동안에는 다시 그리지 않는다 — 그때는 그 줄의
 * 입력칸이 이미 맞는 값을 들고 있다.)
 *
 * 다시 그리면 포커스가 사라지므로 focusIndex 를 받아 되돌려 놓는다. 넘기지
 * 않으면 포커스를 건드리지 않는다(불러오기 직후처럼 캐럿을 뺏으면 안 되는 자리).
 *
 * 편집 잠금은 지금의 loaded 를 그대로 따른다.
 */
function renderLines (focusIndex, caret) {
  lineRows = []
  body.textContent = ''
  for (const line of noteLines) {
    const row = buildLineRow(line)
    body.append(row.el)
    lineRows.push(row)
  }
  // 높이 맞추기는 DOM 에 붙인 **뒤**여야 한다. 붙기 전에는 너비가 0 이라
  // scrollHeight 가 접힘을 반영하지 못한다.
  growAllLines()
  if (Number.isInteger(focusIndex)) {
    focusLine(focusIndex, caret)
  } else {
    focusedLine = Math.max(0, Math.min(focusedLine, lineRows.length - 1))
  }
}

/** 그 줄의 글자 칸으로 캐럿을 옮긴다. caret 을 안 주면 줄 끝이다. */
function focusLine (index, caret) {
  if (lineRows.length === 0) return
  const at = Math.max(0, Math.min(index, lineRows.length - 1))
  const row = lineRows[at]
  focusedLine = at
  row.input.focus()
  const pos = Number.isInteger(caret)
    ? Math.max(0, Math.min(caret, row.input.value.length))
    : row.input.value.length
  row.input.setSelectionRange(pos, pos)
}

/** Keep 의 본문 텍스트를 줄들로 바꿔 화면에 건다. */
function setLinesFromBody (text) {
  noteLines = parseNoteLines(text)
  renderLines()
}

/**
 * 폰에서 만든 진짜 List 노트의 항목들을 같은 편집기에 건다. 체크리스트 UI 를
 * 두 벌 두지 않는다 — 사용자가 보는 것은 어느 쪽이든 같은 줄들이다.
 * Keep 항목 id 는 줄 안에만 두고 DOM 속성에는 심지 않는다.
 */
function setLinesFromItems (items) {
  noteLines = (Array.isArray(items) ? items : []).map((item) => ({
    kind: 'item',
    checked: !!item && item.checked === true,
    text: item && typeof item.text === 'string' ? item.text : '',
    id: item && typeof item.id === 'string' ? item.id : undefined
  }))
  renderLines()
}

// --- 되돌리기 / 다시 하기 ---------------------------------------------------
//
// 기록은 줄 모형 위에 있다(undo-stack.js). <textarea> 의 기본 되돌리기는 코드가
// .value 에 대입하는 순간 무효가 되는데 이 편집기는 줄을 쉴 새 없이 다시 쓴다.
//
// 제목 칸은 이 기록에 들어오지 않는다. 제목은 평범한 한 줄짜리 <input> 이고
// 브라우저의 기본 되돌리기가 거기서는 멀쩡히 동작한다 — 가로채면 오히려 나쁘다.
//
// **무엇을 한 단계로 묶는가**
//   - 한 줄에서 이어 친 글자들: 한 단계. TYPING_GROUP_MS 만큼 쉬거나 다른 줄로
//     옮기면 거기서 끊긴다.
//   - 체크 토글: 그 자체로 한 단계.
//   - 줄 지우기/합치기/나누기, 항목↔글줄 바꾸기, 여러 줄 붙여넣기: 각각 한 단계.

/** 지금 상태(줄들 + 캐럿)를 기록에 담을 모양으로 뜬다. */
function snapshot () {
  const row = lineRows[focusedLine]
  return {
    lines: noteLines.map((line) => ({ ...line })),
    index: focusedLine,
    caret: row && document.activeElement === row.input ? row.input.selectionStart : null
  }
}

function pushHistory (coalesceKey) {
  if (!undoHistory) return
  pushUndoState(undoHistory, snapshot(), coalesceKey)
}

/** 기록에서 꺼낸 상태로 화면을 되돌린다. */
function restoreSnapshot (state) {
  if (!state) return
  noteLines = state.lines.map((line) => ({ ...line }))
  renderLines(state.index, Number.isInteger(state.caret) ? state.caret : undefined)
  onEdit()
}

/** 이어 친 글자 묶음을 여기서 끊는다. */
function breakTypingGroup () {
  clearTimeout(typingGroupTimer)
  typingGroup += 1
}

/** 이 줄에서 이어 치는 동안 같은 값으로 유지되는 묶음 열쇠. */
function typingKeyFor (index) {
  clearTimeout(typingGroupTimer)
  typingGroupTimer = setTimeout(() => { typingGroup += 1 }, TYPING_GROUP_MS)
  return `typing:${index}:${typingGroup}`
}

/** 본문이 바뀌었다. 기록에 한 칸 남기고 저장 타이머를 다시 건다. */
function noteChanged (coalesceKey) {
  pushHistory(coalesceKey)
  onEdit()
}

function doUndo () {
  if (!loaded) return
  const state = undoStep(undoHistory)
  if (!state) {
    // 아무 일도 안 일어나는 것이 제일 나쁘다. 바닥에 닿았으면 그렇다고 말한다.
    status.textContent = '더 되돌릴 것이 없습니다'
    return
  }
  breakTypingGroup()
  restoreSnapshot(state)
}

function doRedo () {
  if (!loaded) return
  const state = redoStep(undoHistory)
  if (!state) {
    status.textContent = '다시 할 것이 없습니다'
    return
  }
  breakTypingGroup()
  restoreSnapshot(state)
}

// --- 줄 편집 ----------------------------------------------------------------

function lineIndexOfInput (target) {
  return lineRows.findIndex((row) => row.input === target)
}

/**
 * 폰에서 만든 진짜 List 노트에서는 줄을 더하거나 뺄 수 없다. 사이드카의
 * update_checklist 가 항목 id 로만 짝을 찾기 때문이다(추가/삭제 경로가 없다).
 * 조용히 아무 일도 안 하지 않고 이유를 말한다.
 */
function refuseStructuralEdit () {
  status.textContent = '폰에서 만든 체크리스트에서는 줄을 더하거나 지울 수 없습니다'
}

/**
 * Enter. 캐럿 자리에서 줄을 나눈다(선택 영역이 있으면 그것을 지우고 나눈다).
 * 항목 아래에 생기는 줄은 항목이다 — 목록을 치던 사람이 원하는 것이 그것이다.
 * 체크 상태는 물려받지 않는다(새 줄은 아직 한 일이 없다).
 */
function splitLine (index) {
  if (isNativeList) { refuseStructuralEdit(); return }
  const input = lineRows[index].input
  const line = noteLines[index]

  // 글자가 빈 항목에서 Enter 는 목록을 끝낸다 — 빈 항목을 또 만들지 않고 이 줄을
  // 평범한 글줄로 되돌린다. 목록에서 빠져나오는 표준 몸짓이다.
  if (line.kind === 'item' && line.text === '') {
    noteLines[index] = { kind: 'text', checked: false, text: '' }
    breakTypingGroup()
    renderLines(index, 0)
    noteChanged(null)
    return
  }

  const start = Math.min(input.selectionStart, input.selectionEnd)
  const end = Math.max(input.selectionStart, input.selectionEnd)
  noteLines[index] = { ...line, text: input.value.slice(0, start) }
  noteLines.splice(index + 1, 0, { kind: line.kind, checked: false, text: input.value.slice(end) })
  breakTypingGroup()
  renderLines(index + 1, 0)
  noteChanged(null)
}

/**
 * 줄 맨 앞에서의 Backspace. (줄 안쪽에서는 브라우저 기본 동작이 글자를 지운다.)
 *
 * 규칙은 셋이다:
 *   1. 글자가 있는 항목 → **체크박스를 뗀다.** 글자는 그대로 남고 평범한 글줄이
 *      된다. 체크리스트로 만든 것을 되돌리는 가장 짧은 몸짓이다.
 *   2. 글자가 빈 항목, 또는 평범한 글줄 → 윗줄 끝에 붙이고 이 줄을 없앤다.
 *      **빈 항목은 이 규칙으로 줄째 사라진다** — 지울 글자가 없는데 체크박스만
 *      남기는 것은 사용자가 기대하는 "지우기"가 아니다.
 *   3. 첫 줄이라 위에 붙일 곳이 없으면: 빈 항목이면 표식만 떼고, 그 밖에는
 *      아무 일도 하지 않는다.
 *
 * 캐럿은 언제나 **이어붙인 자리**에 선다 — 한 편의 글에서 Backspace 를 눌렀을
 * 때 캐럿이 가는 바로 그 자리다.
 */
function backspaceAtLineStart (index) {
  const line = noteLines[index]

  if (line.kind === 'item' && line.text !== '') {
    if (isNativeList) { refuseStructuralEdit(); return }
    noteLines[index] = { kind: 'text', checked: false, text: line.text }
    breakTypingGroup()
    renderLines(index, 0)
    noteChanged(null)
    return
  }

  if (isNativeList) { refuseStructuralEdit(); return }

  if (index === 0) {
    if (line.kind !== 'item') return
    noteLines[0] = { kind: 'text', checked: false, text: '' }
    breakTypingGroup()
    renderLines(0, 0)
    noteChanged(null)
    return
  }

  const previous = noteLines[index - 1]
  const caret = previous.text.length
  noteLines[index - 1] = { ...previous, text: previous.text + line.text }
  noteLines.splice(index, 1)
  breakTypingGroup()
  renderLines(index - 1, caret)
  noteChanged(null)
}

/**
 * 줄 맨 끝에서의 Delete. Backspace 의 거울상이다: 아랫줄을 끌어 올려 붙이고
 * 그 줄을 없앤다. 아랫줄이 항목이었다면 체크박스는 사라지고 글자만 남는다 —
 * 캐럿이 있는 줄이 무엇인지가 이긴다. 캐럿은 이어붙인 자리에 그대로 있다.
 */
function deleteAtLineEnd (index) {
  if (index >= noteLines.length - 1) return
  if (isNativeList) { refuseStructuralEdit(); return }
  const line = noteLines[index]
  const caret = line.text.length
  noteLines[index] = { ...line, text: line.text + noteLines[index + 1].text }
  noteLines.splice(index + 1, 1)
  breakTypingGroup()
  renderLines(index, caret)
  noteChanged(null)
}

/**
 * 줄 하나를 여러 줄로 갈아 끼운다. 여러 줄 붙여넣기와, 어떤 경로로든 값 안에
 * 줄바꿈이 들어왔을 때의 안전망이 같은 함수를 쓴다 — 두 벌로 나뉘면 한쪽만
 * 고쳐지는 날이 온다.
 *
 * mergedText 는 **표식까지 붙인** 온전한 본문 조각이어야 한다. 캐럿은 tailLength
 * 만큼 앞, 즉 "끼워 넣은 글의 끝"에 선다.
 */
function replaceLineWithText (index, mergedText, tailLength) {
  const replacement = parseNoteLines(mergedText)
  const last = replacement.length - 1
  noteLines.splice(index, 1, ...replacement)
  breakTypingGroup()
  renderLines(index + last, Math.max(0, replacement[last].text.length - tailLength))
  noteChanged(null)
}

/**
 * [체크] 버튼과 Ctrl+L. **캐럿이 있는 그 줄 하나**를 항목으로 만들거나 되돌린다.
 * 사용자가 말한 "메모에서 체크리스트를 입력하고 싶을 때 추가"가 이것이다.
 * (표식을 직접 쳐도 된다 — 아래 input 핸들러가 그 자리에서 바꿔 준다.)
 */
function toggleLineKind () {
  if (!loaded) return
  if (isNativeList) {
    status.textContent = '폰에서 만든 체크리스트는 모든 줄이 항목입니다'
    return
  }
  if (noteLines.length === 0) return
  const index = Math.max(0, Math.min(focusedLine, noteLines.length - 1))
  const row = lineRows[index]
  const caret = row && document.activeElement === row.input ? row.input.selectionStart : null
  const line = noteLines[index]
  noteLines[index] = line.kind === 'item'
    ? { kind: 'text', checked: false, text: line.text }
    : { kind: 'item', checked: false, text: line.text }
  breakTypingGroup()
  renderLines(index, Number.isInteger(caret) ? caret : line.text.length)
  noteChanged(null)
}

/**
 * 미저장 편집이 있는가. ✕ / 접기 / 색 변경 / 마지막 flush 요청이 전부 이 하나를
 * 본다 — 두 종류의 메모에 대해 판단이 두 벌로 갈리면 한쪽만 고쳐지는 날이 온다.
 */
function hasUnsavedEdits () {
  if (title.value !== savedTitle) return true
  return isNativeList
    ? checklistSignature(currentItems()) !== savedItemsSig
    : currentBodyText() !== savedText
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
    return
  }
  // 펼쳤다. **접혀 있는 동안(display:none)에는 scrollHeight 가 0 이다** — 그때
  // 그려졌거나 높이를 맞춘 줄들은 높이 0 인 채로 남아 있다. 다시 보이게 된
  // 지금 맞춰야 한다(재시작 복원처럼 접힌 채로 불러온 경우가 정확히 그렇다).
  growAllLines()
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
 * 도착 순서가 보장되지 않는다. 반대로, 색 변경 응답으로 제목 칸/본문 줄들이나
 * savedTitle/savedText 를 절대 건드리지 않는다 — 이 요청은 title/text 를
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
  // 글자 크기가 바뀌면 접히는 자리도 바뀐다. 줄 높이를 다시 맞추지 않으면
  // 24pt 로 올린 순간 줄마다 뒷부분이 잘려 보인다.
  growAllLines()
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
 * 폰에서 만든 진짜 List 노트의 저장. 아래 flush() 의 갈래이고, 모양은 그쪽과
 * 같다: 실패하면 배지로 알리고(편집본은 main 이 conflictBackup 에 보관한다),
 * 충돌이면 서버가 이긴 내용을 화면에 반영한다.
 *
 * 이 앱이 만드는 메모는 전부 text 노트이므로 이 갈래로 오는 것은 사용자가 폰에서
 * 만들어 둔 List 뿐이다. 그래도 저장은 항목 id 를 쓰는 update_checklist 로
 * 나가야 한다 — List.text 는 읽기 전용이라 텍스트로는 쓸 수가 없다.
 *
 * 제목과 항목을 **한 번의 요청**으로 같이 보낸다. 두 번으로 쪼개면 둘의 도착
 * 순서가 보장되지 않고, 하나만 성공하는 반쯤 저장된 상태가 생긴다.
 */
async function flushChecklist (attemptTitle) {
  const attemptItems = currentItems()
  const attemptPlain = currentPlainText()
  const res = await window.keepSticky.updateChecklist(noteId, {
    title: attemptTitle, items: attemptItems
  })
  if (!res.ok) {
    // 배지 툴팁에는 사람이 읽을 요약을 넣는다. 되돌리기용 데이터가 아니다 —
    // 진짜 보관본은 main 이 state.json 의 conflictBackup 에 { title, items } 로
    // 넣어 두었고, 그쪽에는 항목마다 id/text/checked 가 전부 남아 있다.
    showSaveFailure(attemptTitle, attemptPlain)
    status.textContent = res.code === 'AUTH_REQUIRED' ? '재로그인 필요' : '저장 실패 — 편집본 보관됨'
    return
  }
  if (res.conflict) {
    showConflict(attemptTitle, attemptPlain)
    title.value = res.note.title || '' // 서버가 이긴 내용을 보여준다
    setLinesFromItems(res.note.items)
    // 서버가 이긴 내용도 되돌리기 기록에 한 칸 남긴다 — Ctrl+Z 로 내가 쓰던
    // 내용으로 돌아갈 수 있어야 한다(그 상태에서 다시 저장하면 내 것이 이긴다).
    pushHistory(null)
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
  if (isNativeList) {
    status.textContent = '저장 중'
    await flushChecklist(attemptTitle)
    return
  }
  // 줄들을 line-model.js 의 규약대로 한 덩어리 텍스트로 접는다. 체크박스는
  // "- [ ] " / "- [x] " 여섯 글자로 실려 나가고, 폰의 Keep 앱에서는 평범한
  // 글줄로 보인다 — D1(서식은 로컬 전용, Keep 엔 순수 텍스트)의 연장이다.
  const attemptText = currentBodyText()
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
    setLinesFromBody(res.note.text || '')
    // 서버가 이긴 내용도 되돌리기 기록에 한 칸 남긴다 — Ctrl+Z 로 내가 쓰던
    // 내용으로 돌아갈 수 있어야 한다(그 상태에서 다시 저장하면 내 것이 이긴다).
    pushHistory(null)
    savedTitle = title.value
    savedText = currentBodyText()
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

// 제목 칸에서 Enter 는 아무것도 저장/제출하지 않고 본문 첫 줄로 포커스만 옮긴다.
// <input type="text"> 는 애초에 줄바꿈을 넣을 수 없으므로(제목에 줄바꿈이
// 없다는 규칙을 컨트롤 자체가 강제한다) 여기서 막을 "제출"은 없지만, 감싸는
// <form> 이 없어도 브라우저마다 Enter 처리가 다를 수 있어 명시적으로 막는다.
//
// 조합 중(한글 IME)의 Enter 는 글자를 확정하는 키다. 가로채면 "회"를 확정하려던
// Enter 가 본문으로 뛰어 버린다.
title.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key !== 'Enter') return
  e.preventDefault()
  focusLine(0, 0)
})

// --- 본문 편집기의 이벤트 ---------------------------------------------------
//
// 전부 #body 한 곳에 위임한다. 줄마다 리스너를 달면 다시 그릴 때마다 수십 개를
// 떼었다 붙여야 하고, 하나라도 놓치면 유령 리스너가 남는다.

body.addEventListener('focusin', (e) => {
  const index = lineRows.findIndex((row) => row.input === e.target || row.check === e.target)
  if (index >= 0) focusedLine = index
})

// 입력칸 **바깥**을 눌렀을 때. 본문이 textarea 하나였을 때는 어디를 눌러도
// 캐럿이 놓였다 — 글 아래의 빈 자리를 누르면 글 끝으로 갔다. 지금은 줄의 여백,
// 줄들 사이, #body 의 안쪽 여백을 누르면 아무 일도 일어나지 않는다. 그 빈
// 반응을 메운다.
body.addEventListener('mousedown', (e) => {
  if (lineRows.length === 0) return
  // 입력칸이나 체크박스를 바로 눌렀으면 브라우저가 알아서 한다.
  if (lineRows.some((row) => row.input === e.target || row.check === e.target)) return
  // 스크롤막대를 눌렀을 수도 있다(#body 는 스크롤된다). 여기서 기본 동작을
  // 막으면 막대를 끌어 스크롤할 수가 없게 된다 — clientWidth 는 막대를 뺀
  // 너비라 그보다 오른쪽이면 막대 위다.
  if (e.target === body && e.offsetX >= body.clientWidth) return

  // 누른 높이에 걸리는 줄을 찾는다. 그보다 아래(빈 자리)면 마지막 줄이다.
  let at = lineRows.length - 1
  for (let i = 0; i < lineRows.length; i += 1) {
    if (e.clientY < lineRows[i].el.getBoundingClientRect().bottom) { at = i; break }
  }
  e.preventDefault()
  // 글자 칸보다 왼쪽(체크박스 자리)을 눌렀으면 줄 앞, 그 밖에는 줄 끝이다.
  focusLine(at, e.clientX < lineRows[at].input.getBoundingClientRect().left ? 0 : undefined)
})

body.addEventListener('input', (e) => {
  const index = lineIndexOfInput(e.target)
  if (index < 0) return
  focusedLine = index
  const line = noteLines[index]
  line.text = e.target.value
  growLine(e.target)

  // 안전망. Enter 는 아래에서 가로채고 여러 줄 붙여넣기도 따로 다루므로 값 안에
  // 줄바꿈이 들어올 일이 없어야 하지만, 끌어놓기처럼 우리가 세지 않은 경로가
  // 남아 있을 수 있다. 남겨 두면 한 줄의 값 안에 줄바꿈이 숨어 화면(줄 하나)과
  // 저장본(줄 여럿)이 달라진다.
  if (!isNativeList && line.text.includes('\n')) {
    replaceLineWithText(index, serializeNoteLine(line), 0)
    return
  }

  // 마크다운식 자동 변환. 평범한 글줄 맨 앞에 표식 여섯 글자를 다 치면 그 자리에서
  // 항목이 된다 — "메모에서 체크리스트를 입력하고 싶을 때 추가"의 가장 짧은
  // 길이다. 덤으로 이것이 있어서, 화면에 글줄로 남아 있던 것이 저장 뒤 다시
  // 읽힐 때 항목으로 바뀌어 보이는 어긋남이 생기지 않는다.
  //
  // 조합 중에는 건드리지 않는다. 표식은 전부 ASCII 라 한글 조합 중에 완성될 수
  // 없지만, 조합 중에 DOM 을 다시 그리면 IME 가 깨진다.
  if (!isNativeList && !e.isComposing && line.kind === 'text') {
    const parsed = parseNoteLine(line.text)
    if (parsed.kind === 'item') {
      const caret = e.target.selectionStart
      noteLines[index] = { kind: 'item', checked: parsed.checked, text: parsed.text }
      breakTypingGroup()
      renderLines(index, Math.max(0, caret - LINE_MARK_UNCHECKED.length))
      noteChanged(null)
      return
    }
  }
  noteChanged(typingKeyFor(index))
})

// **체크 토글도 글자 편집도 같은 onEdit 을 지난다.** 그래서 같은 디바운스 타이머
// 하나를 다시 걸 뿐이고, 연달아 여러 개를 체크해도 네트워크 요청은 마지막 한
// 번으로 접힌다 — 글자를 치는 것과 정확히 같은 방식이다.
body.addEventListener('change', (e) => {
  const index = lineRows.findIndex((row) => row.check === e.target)
  if (index < 0) return
  noteLines[index].checked = e.target.checked === true
  lineRows[index].el.classList.toggle('checked', noteLines[index].checked)
  // 다시 그리지 않는다: 바뀌는 것은 이 줄의 class 하나뿐이고, 다시 그리면
  // 방금 누른 체크박스가 사라져 포커스가 튄다.
  breakTypingGroup()
  noteChanged(null)
})

body.addEventListener('keydown', (e) => {
  // 한글 조합 중에는 어떤 키도 가로채지 않는다. keyCode 229 는 조합 중임을
  // 알리는 옛 신호이고, 브라우저에 따라 isComposing 보다 먼저 온다.
  if (e.isComposing || e.keyCode === 229) return

  if (e.ctrlKey || e.metaKey) {
    const key = typeof e.key === 'string' ? e.key.toLowerCase() : ''
    // 기본 동작을 반드시 막는다. 입력칸의 기본 되돌리기는 이 편집기가 값을
    // 다시 쓰는 순간 이미 무의미해졌고, 그대로 두면 우리 기록과 둘이 싸운다.
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return }
    if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); return }
    if (key === 'l') { e.preventDefault(); toggleLineKind(); return }
    return // Ctrl+A/C/V 등은 브라우저에 맡긴다
  }
  if (!loaded) return

  const index = lineIndexOfInput(e.target)
  if (index < 0) return
  focusedLine = index
  const input = e.target
  const start = Math.min(input.selectionStart, input.selectionEnd)
  const end = Math.max(input.selectionStart, input.selectionEnd)
  const atStart = start === 0 && end === 0
  const atEnd = start === input.value.length && end === input.value.length

  switch (e.key) {
    case 'Enter':
      e.preventDefault()
      splitLine(index)
      return
    case 'Backspace':
      // 줄 안쪽에서는 브라우저가 글자를 지운다. 맨 앞에서만 우리가 나선다.
      if (!atStart) return
      e.preventDefault()
      backspaceAtLineStart(index)
      return
    case 'Delete':
      if (!atEnd) return
      e.preventDefault()
      deleteAtLineEnd(index)
      return
    // 아래 넷이 "줄이 여럿이어도 한 편의 글처럼" 느끼게 하는 전부다.
    //
    // 접히지 않은 줄에서는 곧바로 윗줄/아랫줄로 건너뛴다(칸을 유지한 채로).
    // 접힌 줄에서는 브라우저가 그 안의 시각적 줄을 오르내리게 두고, 맨 위/맨
    // 아래에 닿았을 때(캐럿이 0 또는 끝)만 우리가 넘긴다.
    case 'ArrowUp': {
      if (index === 0) return
      const single = isSingleVisualRow(input)
      if (!single && start !== 0) return
      e.preventDefault()
      focusLine(index - 1, single ? start : undefined) // undefined = 윗줄 끝
      return
    }
    case 'ArrowDown': {
      if (index >= lineRows.length - 1) return
      const single = isSingleVisualRow(input)
      if (!single && start !== input.value.length) return
      e.preventDefault()
      focusLine(index + 1, single ? start : 0)
      return
    }
    case 'ArrowLeft':
      if (!atStart || index === 0) return
      e.preventDefault()
      focusLine(index - 1) // 윗줄 끝
      return
    case 'ArrowRight':
      if (!atEnd || index >= lineRows.length - 1) return
      e.preventDefault()
      focusLine(index + 1, 0)
      return
    default:
  }
})

// 여러 줄 붙여넣기. 그냥 두면 줄바꿈이 그대로 한 줄짜리 textarea 의 값 안에
// 들어가 화면(줄 하나)과 저장본(줄 여럿)이 어긋난다. 붙여넣은 글에 표식이
// 있으면(다른 메모에서 복사한 체크리스트) 체크박스까지 그대로 따라온다.
// 한 줄짜리 붙여넣기는 브라우저에 맡긴다.
body.addEventListener('paste', (e) => {
  if (!loaded) return
  const index = lineIndexOfInput(e.target)
  if (index < 0) return
  const raw = e.clipboardData ? e.clipboardData.getData('text/plain') : ''
  if (typeof raw !== 'string' || !/[\r\n]/.test(raw)) return
  e.preventDefault()
  if (isNativeList) { refuseStructuralEdit(); return }

  const input = e.target
  const line = noteLines[index]
  const start = Math.min(input.selectionStart, input.selectionEnd)
  const end = Math.max(input.selectionStart, input.selectionEnd)
  const tail = input.value.slice(end)
  // 캐럿 앞부분은 **표식까지 붙인 모양**으로 되돌려 이어야 한다. 그래야 항목
  // 한가운데에 붙여넣어도 그 줄이 항목인 채로 남는다.
  const head = serializeNoteLine({ ...line, text: input.value.slice(0, start) })
  replaceLineWithText(index, head + raw.replace(/\r\n?/g, '\n') + tail, tail.length)
})

// [체크] 버튼. mousedown 의 기본 동작을 막아 캐럿이 있던 줄에서 포커스가
// 빠져나가지 않게 한다 — 그래야 "지금 이 줄"이 버튼을 누르는 순간에도 그대로다.
lineToggle.addEventListener('mousedown', (e) => { e.preventDefault() })
lineToggle.addEventListener('click', () => { toggleLineKind() })

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

// 창을 좁히거나 넓히면 줄이 접히는 자리가 달라진다(펼칠 때도 온다). 높이를 다시
// 맞추지 않으면 좁힌 창에서 줄마다 뒷부분이 잘려 보인다.
window.addEventListener('resize', () => { growAllLines() })

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
  // #body 는 이제 <div> 라 [readonly] 선택자가 걸리지 않는다. 잠긴 모습은
  // .locked 클래스가 맡는다(note.html 의 규칙).
  body.classList.toggle('locked', !enabled)
  // 줄들도 같이 잠근다. 여기를 빼먹으면 불러오지 못한 창에서 체크를 눌러 빈
  // 본문이 저장되는 길이 열린다 — 그것이 곧 메모 전부 지우기다.
  // (체크상자는 readOnly 를 지원하지 않으므로 disabled 를 쓴다.)
  for (const row of lineRows) {
    row.input.readOnly = !enabled
    if (row.check) row.check.disabled = !enabled
  }
  setSwatchesEnabled(enabled)
  deleteButton.disabled = !enabled
  // 폰에서 만든 진짜 List 노트에서는 줄의 종류를 바꿀 수 없다 — 모든 줄이
  // 항목이고 그래야만 한다.
  lineToggle.disabled = !enabled || isNativeList
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
 * 이제 본문이 여러 입력칸이므로 **그 줄 하나의 값**만 넘긴다. 그래도 놓치는
 * 주소는 없다: URL 에는 공백이 들어갈 수 없어 줄을 넘어가는 주소가 없기
 * 때문이다(urlAtCaret 의 스캔도 공백에서 멈춘다).
 *
 * 여기서 하는 검사는 **안내를 위한 것**이다. 진짜 검증은 main 프로세스의
 * shell:openExternal 핸들러가 같은 sanitizeUrl 로 다시 한다 — 렌더러는 신뢰
 * 경계의 바깥쪽이라 이쪽 검사만으로는 검사가 아니다.
 */
async function openUrlAtCaret (input) {
  const found = urlAtCaret(input.value, input.selectionStart)
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

// 입력칸에는 링크 요소가 없으므로 누를 대상도, 꾸밀 것도 없다. 대신 클릭이
// 캐럿을 옮긴다는 사실을 쓴다 — click 이 오는 시점에는 selectionStart 가 이미
// 눌린 자리로 옮겨져 있다. preventDefault 는 부르지 않는다: 캐럿 이동은 이미
// 끝났고, 여기서 기본 동작을 막아 봐야 얻을 것이 없다.
//
// 평범한 클릭이 아니라 Ctrl+클릭인 이유가 이것이다. 평범한 클릭은 여전히 글자
// 사이에 커서를 놓는 본래의 일을 해야 한다. (macOS 를 위해 metaKey 도 같이
// 받는다 — 이 앱은 지금 Windows 전용이지만 한 줄로 끝나는 배려다.)
body.addEventListener('click', (e) => {
  if (!e.ctrlKey && !e.metaKey) return
  const index = lineIndexOfInput(e.target)
  if (index < 0) return
  openUrlAtCaret(e.target)
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

  // 제목 칸은 두 종류 모두에 있다. 갈라지는 것은 **저장 경로**뿐이다 — 화면은
  // 어느 쪽이든 같은 줄 편집기다.
  //
  // kind 는 사이드카가 실어 준다("note" 또는 "list"). 이 값은 창의 수명 동안
  // 바뀌지 않는다 — Keep 의 노트는 Note 이거나 List 이고 둘 사이에 변환 경로가
  // 없기 때문이다(gkeepapi 의 type 에는 setter 도 convert* 도 없다).
  //
  // 이 앱이 만드는 메모는 언제나 text 노트다. list 로 오는 것은 사용자가 폰에서
  // 만들어 둔 것뿐이고, 그것도 열려서 쓸 수 있어야 한다.
  isNativeList = note.kind === 'list'
  if (isNativeList) {
    setLinesFromItems(note.items)
    savedItemsSig = checklistSignature(currentItems())
    lineToggle.title = '폰에서 만든 체크리스트입니다 — 모든 줄이 항목이고 줄을 더하거나 지울 수 없습니다'
  } else {
    setLinesFromBody(note.text || '')
    // serializeNoteLines(parseNoteLines(s)) === s 이므로 이 값은 note.text 와
    // 글자 하나까지 같다. 그래도 화면이 실제로 들고 있는 값에서 뽑는다 —
    // 미저장 판정의 두 항이 같은 함수에서 나와야 어긋나지 않는다.
    savedText = currentBodyText()
  }
  // 되돌리기 기록은 **불러온 뒤에** 생긴다. 그래야 바닥이 "Keep 에서 온 원본"이고,
  // 사용자가 Ctrl+Z 를 끝까지 눌러도 빈 화면이 나오지 않는다.
  undoHistory = createUndoStack(snapshot(), UNDO_STEP_LIMIT)
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
