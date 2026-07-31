'use strict'

const DEBOUNCE_MS = 1500
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

const body = document.getElementById('body')
const status = document.getElementById('status')
const badge = document.getElementById('badge')

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

document.addEventListener('contextmenu', async (e) => {
  e.preventDefault()
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
  loaded = true
  body.readOnly = false // 여기가 편집이 열리는 유일한 지점이다
  status.textContent = ''
}).catch((err) => {
  showLoadFailure(err && err.message ? err.message : String(err))
})
