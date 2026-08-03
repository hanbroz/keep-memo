'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// 렌더러가 닿을 수 있는 표면은 이 목록이 전부다. Keep 본문은 외부 데이터이고
// Phase 3 에서 리치 텍스트를 다루게 되므로, Node API 경로를 처음부터 막는다.
contextBridge.exposeInMainWorld('keepSticky', {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (title, text) => ipcRenderer.invoke('notes:create', title, text),
  updateNote: (id, patch) => ipcRenderer.invoke('notes:update', id, patch),
  // 체크리스트. Keep 의 노트는 Note 이거나 List 이고 둘 사이에 변환 경로가 없어서
  // (gkeepapi 의 type 에는 setter 도 convert* 도 없다) 만들 때 종류가 정해진다 —
  // 그래서 만들기도 저장하기도 text 메모와 따로 있다. items 는
  // [{ id, text, checked }] 이고, 검증은 checklist-items.js 한 벌을 렌더러/main/
  // 사이드카가 나눠 쓴다.
  createChecklist: (title, items) => ipcRenderer.invoke('notes:createChecklist', title, items),
  updateChecklist: (id, patch) => ipcRenderer.invoke('notes:updateChecklist', id, patch),
  // 포스트잇 본문에서 Ctrl+클릭한 주소를 기본 브라우저로 연다. 렌더러가 이미
  // 한 번 걸렀더라도 main 이 다시 검증한다 — http/https 가 아니면 열리지 않는다.
  // 여기서 shell 을 직접 노출하지 않는 것이 핵심이다: 렌더러가 닿는 것은 "주소
  // 문자열 하나를 보내 본다"는 이 함수뿐이고, 실제 openExternal 호출은 검증을
  // 지난 뒤 main 에서만 일어난다.
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // 지우기. Keep 휴지통으로 보내는 것이고 7일간 복구할 수 있다(사이드카의
  // node.trash()). 포스트잇의 [삭제] 버튼과 우클릭이 둘 다 확인 뒤에 이것 하나를
  // 부른다 — ✕(closeNote)와 목록 창의 체크 해제는 여기 오지 않는다.
  trashNote: (id) => ipcRenderer.invoke('notes:trash', id),
  openNote: (id) => ipcRenderer.invoke('notes:open', id),
  closeNote: (id) => ipcRenderer.invoke('notes:close', id),
  // 목록 창(체크 상자) 전용. visibleIds 는 지금 바탕화면에 떠 있는 메모 id 를
  // 돌려주고, applySelection 은 체크된 집합에 맞춰 띄우고 내린다. 내리기는
  // 바탕화면에서만 내리는 것이며 Keep 메모를 지우는 경로는 여기 없다.
  visibleIds: () => ipcRenderer.invoke('notes:visibleIds'),
  applySelection: (ids) => ipcRenderer.invoke('notes:applySelection', ids),
  // [완료] 는 반영이 끝나면 목록 창을 닫는다. 앱은 트레이에서 계속 살아 있고
  // 트레이 아이콘으로 다시 연다. main 은 목록 창일 때만 이 요청을 받아준다 —
  // 포스트잇은 자기 ✕(closeNote) 를 거쳐야 state.json 에 내린 것으로 남는다.
  closeList: () => ipcRenderer.invoke('list:close'),
  // 포스트잇 ↔ 책갈피. 좌표 계산과 저장은 전부 main 프로세스가 한다.
  foldNote: (id) => ipcRenderer.invoke('notes:fold', id),
  unfoldNote: (id) => ipcRenderer.invoke('notes:unfold', id),
  // main 이 접힘 상태를 알려준다. 재시작 복원처럼 렌더러가 스스로 알 수 없는
  // 경로가 있으므로 창이 뜬 직후에도 한 번 온다. 이벤트 객체는 넘기지 않는다.
  onFoldState: (cb) => ipcRenderer.on('notes:foldState', (_e, folded) => cb(!!folded)),
  exchangeCookie: (token) => ipcRenderer.invoke('auth:exchange', token),
  noteId: () => ipcRenderer.invoke('notes:currentId'),
  // 최초 실행 설정 창(setup-email.html) 전용. 입력값을 검증/저장하는 것은
  // 항상 main 프로세스다 — 렌더러는 결과 메시지를 보여주기만 한다.
  submitEmail: (email) => ipcRenderer.invoke('setup:submitEmail', email),
  // 메인 프로세스가 창을 닫기 직전에 부른다. ✕ 를 거치지 않는 닫기(Alt+F4,
  // 종료/로그오프)에서도 미저장 편집을 저장할 마지막 기회다. 이벤트 객체는
  // 렌더러에 넘기지 않는다 — sender 를 통해 IPC 표면이 새어나가면 안 된다.
  onFlushRequest: (cb) => ipcRenderer.on('notes:flush', () => cb()),
  flushDone: () => ipcRenderer.send('notes:flushed'),
  // 서체 설정. 저장은 언제나 main 이 한다(store.js 가 검증하고 state.json 에
  // 쓴다). setFontSettings 는 실제로 저장된 값을 돌려주므로, 렌더러는 자기가
  // 보낸 값이 아니라 돌아온 값을 화면에 입히면 된다.
  getFontSettings: () => ipcRenderer.invoke('settings:getFonts'),
  setFontSettings: (settings) => ipcRenderer.invoke('settings:setFonts', settings),
  // 한 창에서 바꾼 설정이 다시 뜨지 않고도 모든 창에 반영되게 하는 통로.
  // 이벤트 객체는 넘기지 않는다(onFoldState / onFlushRequest 와 같은 관례).
  onFontSettings: (cb) => ipcRenderer.on('settings:fonts', (_e, settings) => cb(settings)),
  // 노트 한 장만의 서체 재정의(포스트잇 전용). Keep 에는 서체 필드가 없어서
  // 이 값은 state.json 의 그 노트 항목 안에만 산다. 저장은 언제나 main 이 하고
  // (store.js 가 note-font.js 로 검증한다), setNoteFont 는 실제로 저장된 값을
  // 돌려준다 — 재정의가 하나도 없으면 null 이다.
  getNoteFont: (id) => ipcRenderer.invoke('notes:getFont', id),
  setNoteFont: (id, override) => ipcRenderer.invoke('notes:setFont', id, override),
  // 목록 창 전용. Keep 쪽 노트 집합이 바뀌었으니 다시 불러오라는 신호다(지금은
  // 포스트잇을 휴지통으로 보냈을 때만 온다). 내용은 싣지 않는다 — 무엇이
  // 바뀌었는지는 목록 창이 list_notes 로 직접 다시 읽는 편이 정확하다.
  onNotesChanged: (cb) => ipcRenderer.on('notes:changed', () => cb())
})
