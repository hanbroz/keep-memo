'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// 렌더러가 닿을 수 있는 표면은 이 목록이 전부다. Keep 본문은 외부 데이터이고
// Phase 3 에서 리치 텍스트를 다루게 되므로, Node API 경로를 처음부터 막는다.
contextBridge.exposeInMainWorld('keepSticky', {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (title, text) => ipcRenderer.invoke('notes:create', title, text),
  updateNote: (id, patch) => ipcRenderer.invoke('notes:update', id, patch),
  trashNote: (id) => ipcRenderer.invoke('notes:trash', id),
  openNote: (id) => ipcRenderer.invoke('notes:open', id),
  closeNote: (id) => ipcRenderer.invoke('notes:close', id),
  exchangeCookie: (token) => ipcRenderer.invoke('auth:exchange', token),
  noteId: () => ipcRenderer.invoke('notes:currentId'),
  // 최초 실행 설정 창(setup-email.html) 전용. 입력값을 검증/저장하는 것은
  // 항상 main 프로세스다 — 렌더러는 결과 메시지를 보여주기만 한다.
  submitEmail: (email) => ipcRenderer.invoke('setup:submitEmail', email),
  // 메인 프로세스가 창을 닫기 직전에 부른다. ✕ 를 거치지 않는 닫기(Alt+F4,
  // 종료/로그오프)에서도 미저장 편집을 저장할 마지막 기회다. 이벤트 객체는
  // 렌더러에 넘기지 않는다 — sender 를 통해 IPC 표면이 새어나가면 안 된다.
  onFlushRequest: (cb) => ipcRenderer.on('notes:flush', () => cb()),
  flushDone: () => ipcRenderer.send('notes:flushed')
})
