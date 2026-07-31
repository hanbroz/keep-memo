'use strict'

const DEBOUNCE_MS = 1500
let noteId = null
let timer = null

const body = document.getElementById('body')
const status = document.getElementById('status')
const badge = document.getElementById('badge')

function showConflict (sentText) {
  badge.textContent = '다른 기기에서 수정됨 — 내 편집본은 보관되어 있습니다'
  badge.classList.add('show')
  badge.title = sentText
}

async function flush () {
  status.textContent = '저장 중'
  try {
    const res = await window.keepSticky.updateNote(noteId, { text: body.value })
    if (res.conflict) {
      showConflict(res.sentText)
      body.value = res.note.text // 서버가 이긴 내용을 보여준다
    } else {
      badge.classList.remove('show')
    }
    status.textContent = '저장됨'
  } catch (err) {
    // 네트워크 끊김이나 토큰 만료. 사용자가 친 내용은 화면에 그대로 둔다.
    status.textContent = err.code === 'AUTH_REQUIRED' ? '재로그인 필요' : '대기 중'
  }
}

body.addEventListener('input', () => {
  status.textContent = ''
  clearTimeout(timer)
  timer = setTimeout(flush, DEBOUNCE_MS)
})

document.getElementById('close').addEventListener('click', () => {
  clearTimeout(timer)
  window.keepSticky.closeNote(noteId)
})

document.addEventListener('contextmenu', async (e) => {
  e.preventDefault()
  if (!confirm('이 메모를 Keep 휴지통으로 보낼까요? 7일간 복구할 수 있습니다.')) return
  await window.keepSticky.trashNote(noteId)
})

window.keepSticky.noteId().then(async (id) => {
  noteId = id
  const { notes } = await window.keepSticky.listNotes()
  const note = notes.find((n) => n.id === id)
  body.value = note ? note.text : ''
})
