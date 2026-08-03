'use strict'

const DEBOUNCE_MS = 1500
// 책갈피에 세로로 그릴 글자 수 상한. 넘치면 잘라낸다 — 화면 가장자리에 붙는
// 띠는 길어질 수 없고, 길어지면 아래 책갈피들을 밀어낸다.
const BOOKMARK_MAX_CHARS = 10
let noteId = null
let timer = null
// 서버에 마지막으로 반영된(또는 애초에 불러온) 텍스트. "타이머가 걸려
// 있는가"가 아니라 이 값과 body.value 가 다른가로 미저장 편집 유무를
// 판단한다 — 우클릭 후 취소처럼 타이머 없이도 미저장 편집이 남는 경로가
// 있기 때문이다.
let savedText = ''
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

const body = document.getElementById('body')
const status = document.getElementById('status')
const badge = document.getElementById('badge')
const bookmark = document.getElementById('bookmark')
const bookmarkLabel = document.getElementById('bookmark-label')

function showConflict (sentText) {
  badge.textContent = '다른 기기에서 수정됨 — 내 편집본은 보관되어 있습니다'
  badge.classList.add('show')
  badge.title = sentText
}

function showSaveFailure (unsavedText) {
  // 다른 기기와의 충돌이 아니라 저장 자체(네트워크/재로그인/사이드카)가
  // 실패한 경우다. 같은 배지 UI 를 재사용하되 문구는 다르게 둔다 — 사용자가
  // "누군가 내 메모를 고쳤다"로 오해하면 안 된다. main 프로세스가 이미
  // conflictBackup 에 이 텍스트를 저장했다.
  badge.textContent = '저장 실패 — 내 편집본은 보관되어 있습니다'
  badge.classList.add('show')
  badge.title = unsavedText
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
  if (folded) renderBookmark()
}

function showLoadFailure (message) {
  // 배지를 재사용하되 문구는 다르다. 이건 충돌도 저장 실패도 아니고 "아직 아무
  // 것도 못 받았다"는 상태다. 사용자가 여기에 타이핑할 수 있으면 안 된다.
  badge.textContent = `메모를 불러오지 못했습니다 — 편집이 잠겨 있습니다: ${message}`
  badge.classList.add('show')
  badge.title = message
  status.textContent = '불러오기 실패'
}

async function flush () {
  // 불러오지 못한(또는 아직 못 불러온) 본문으로는 절대 저장하지 않는다.
  // 이 한 줄이 "빈 포스트잇에 한 글자 → Keep 메모 전체가 그 한 글자로 교체"
  // 를 막는 마지막 방어선이다.
  if (!loaded) return
  const attempt = body.value
  status.textContent = '저장 중'
  const res = await window.keepSticky.updateNote(noteId, { text: attempt })
  if (!res.ok) {
    // notes:update 는 이제 실패해도 거절(reject)하지 않고 { ok:false } 로
    // 응답한다 — ipcMain.handle 이 던지면 err.code 가 IPC 경계를 못 건너오기
    // 때문이다. 사용자가 친 내용은 이미 main 프로세스가 conflictBackup 으로
    // 보관했으니 여기서는 알리기만 한다.
    showSaveFailure(attempt)
    status.textContent = res.code === 'AUTH_REQUIRED' ? '재로그인 필요' : '저장 실패 — 편집본 보관됨'
    return
  }
  if (res.conflict) {
    showConflict(res.sentText)
    body.value = res.note.text // 서버가 이긴 내용을 보여준다
    savedText = res.note.text
  } else {
    badge.classList.remove('show')
    savedText = attempt
  }
  status.textContent = '저장됨'
}

body.addEventListener('input', () => {
  status.textContent = ''
  clearTimeout(timer)
  timer = setTimeout(flush, DEBOUNCE_MS)
})

document.getElementById('close').addEventListener('click', async () => {
  // 디바운스 타이머를 먼저 끊는다 — 곧이어 flush() 를 직접 부르므로,
  // 남은 타이머가 뒤늦게 두 번째 저장을 걸지 않게 한다.
  clearTimeout(timer)
  // "타이머가 걸려 있었는가"는 미저장 편집의 정확한 신호가 아니다 (우클릭 →
  // 취소 경로는 타이머 없이도 미저장 편집을 남긴다). 실제로 서버에 반영된
  // 마지막 텍스트와 다른지로 판단한다.
  if (body.value !== savedText) {
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
  if (loaded && body.value !== savedText) {
    // flush() 는 실패해도 거절하지 않는다. 실패분은 main 이 conflictBackup 에
    // 보관하고 배지를 띄운다 — 배지는 DOM 에 그대로 남아 펼치면 다시 보인다.
    await flush()
  }
  await window.keepSticky.foldNote(noteId)
})

// 책갈피를 누르면 접기 직전의 위치와 크기 그대로 돌아온다. 좌표는 main 이
// state.json 에 들고 있으므로 렌더러는 요청만 한다.
bookmark.addEventListener('click', () => window.keepSticky.unfoldNote(noteId))

// 접힘 여부는 main 이 정하고 알려준다. 창이 뜬 직후에도 한 번 오므로 재시작
// 복원(지난 세션에 접힌 채 끝난 메모)에서도 책갈피 모습으로 그려진다.
window.keepSticky.onFoldState((next) => {
  folded = next
  applyFoldUI()
})

document.addEventListener('contextmenu', async (e) => {
  e.preventDefault()
  // 접힌 책갈피 위에서는 휴지통 경로를 열지 않는다. 44px 짜리 띠 위의 우클릭은
  // 빗나가기 쉽고, 그 끝에 있는 것이 되돌리기 어려운 동작이다. 지우려면 먼저
  // 펼쳐서 어떤 메모인지 보게 한다.
  if (folded) return
  // confirm() 이 렌더러의 유일한 JS 스레드를 막고 있는 동안 디바운스 타이머가
  // 기한을 넘기면, 스레드가 풀리는 순간(대화상자가 닫히자마자) 그 콜백이
  // trash_note 보다 먼저 또는 뒤에 끼어들어 update_note 와 trash_note 가
  // 순서 보장 없이 경합할 수 있다. close 핸들러처럼 여기서도 제일 먼저
  // 타이머를 끊는다.
  clearTimeout(timer)
  if (!confirm('이 메모를 Keep 휴지통으로 보낼까요? 7일간 복구할 수 있습니다.')) return
  status.textContent = '휴지통으로 보내는 중'
  const res = await window.keepSticky.trashNote(noteId)
  if (!res.ok) {
    // 실패하면 main 프로세스가 창을 닫지 않으므로 메모와 창은 그대로다.
    // 사용자가 "휴지통으로 보냈다"고 착각한 채 창을 닫지 않도록 알린다.
    status.textContent = res.code === 'AUTH_REQUIRED' ? '재로그인 필요' : '휴지통 이동 실패'
    return
  }
  // 휴지통으로 보냈으면 이 창의 저장 경로를 닫는다. main 이 곧 창을 닫는데,
  // 그 닫기 경로가 마지막 flush 를 요청하므로 열어두면 방금 버린 메모에
  // update_note 가 날아간다.
  loaded = false
  body.readOnly = true
})

// 메인 프로세스가 창을 닫기 직전에 부른다 (Alt+F4·종료 등 ✕ 를 거치지 않는
// 경로 포함). 저장할 게 없으면 곧바로 끝났다고 알린다 — 메인은 유한한 시간만
// 기다리므로 어떤 경로로든 반드시 응답해야 한다.
window.keepSticky.onFlushRequest(async () => {
  clearTimeout(timer)
  try {
    if (loaded && body.value !== savedText) await flush()
  } finally {
    window.keepSticky.flushDone()
  }
})

window.keepSticky.noteId().then(async (id) => {
  // id 는 ✕(닫기)에도 필요하므로 먼저 잡는다. 불러오기가 실패해도 사용자가
  // 창을 내릴 수는 있어야 한다. 저장 경로를 여는 것은 이 id 가 아니라 아래의
  // loaded / readOnly 다.
  noteId = id
  status.textContent = '불러오는 중'
  const { notes } = await window.keepSticky.listNotes()
  const note = notes.find((n) => n.id === id)
  // 목록에 없는 id 도 실패다. 여기서 빈 문자열로 폴백하면 그게 곧 원본 삭제다.
  if (!note) throw new Error('목록에서 이 메모를 찾지 못했습니다')
  body.value = note.text
  savedText = note.text
  // Keep 의 색 이름을 그대로 속성 값으로 심는다 (innerHTML 경로가 아니다).
  // note.html 에 없는 이름이면 어느 규칙에도 안 걸려 기본 노란색이 남는다.
  if (note.color) document.body.dataset.color = note.color
  bookmarkText = note.title || (note.text || '').split('\n')[0] || ''
  loaded = true
  body.readOnly = false // 여기가 편집이 열리는 유일한 지점이다
  status.textContent = ''
  // 접힘 통보가 불러오기보다 먼저 왔을 수 있다(재시작 복원). 이제 제목을
  // 알았으니 책갈피 글자를 제대로 다시 그린다.
  applyFoldUI()
}).catch((err) => {
  showLoadFailure(err && err.message ? err.message : String(err))
  applyFoldUI()
})
