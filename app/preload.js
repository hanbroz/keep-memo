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
  noteId: () => ipcRenderer.invoke('notes:currentId')
})
