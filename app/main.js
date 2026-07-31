'use strict'
const path = require('node:path')
const { app, BrowserWindow, ipcMain, session, dialog } = require('electron')
const { Sidecar } = require('./sidecar')
const { Store } = require('./store')
const { createLoginWindow, pollCookie } = require('./login')
const { resolveSidecarCommand } = require('./sidecar-path')

const EMAIL_KEY = 'you@gmail.com' // Phase 2 에서 설정 화면으로 옮긴다
const PRELOAD = path.join(__dirname, 'preload.js')
// 창을 닫기 전에 렌더러의 마지막 저장을 기다려 주는 시간. 응답 없는(혹은
// 이미 사라진) 렌더러 하나 때문에 종료가 막히면 안 되므로 반드시 유한하다.
// flush 하나를 잃는 편이 닫히지 않는 앱보다 낫다.
const FLUSH_ON_CLOSE_MS = 3000

let sidecar = null
let store = null
let sidecarStopped = false
let quitTeardownStarted = false
const noteWindows = new Map() // noteId -> BrowserWindow
const flushWaiters = new Map() // webContents.id -> 대기 해제 함수

function startSidecar () {
  const { command, args } = resolveSidecarCommand(app.isPackaged, process.resourcesPath, __dirname)
  sidecar = new Sidecar(command, args, {
    maxRestarts: 3,
    // 재시작된 파이썬 프로세스는 set_account 이전 상태다. 여기서 다시 세우지
    // 않으면 이후 모든 호출이 AUTH_REQUIRED 로 떨어지고, 재로그인해도 낫지
    // 않는다 — 즉 "재시작 3회"가 죽음을 감추면서 고장을 확정짓는다.
    onRestart: (s) => s.call('set_account', { email: EMAIL_KEY }),
    onDead: (message) => {
      dialog.showErrorBox('Keep 연결 끊김',
        `백그라운드 서비스가 반복해서 종료되었습니다.\n\n${message}\n\n` +
        '앱을 다시 시작해 주세요. 편집 중이던 내용은 저장되지 않았을 수 있습니다.')
    }
  }).start()
  return sidecar
}

// 사이드카 정리는 멱등하다. 종료 경로가 여러 개라 겹쳐 불리는 것이 정상이다.
function stopSidecar () {
  sidecarStopped = true
  if (sidecar) sidecar.stop()
}

/**
 * 창을 닫기 직전에 렌더러가 미저장 편집을 저장하도록 요청하고 기다린다.
 * 렌더러가 죽었거나 응답이 없거나 사이드카가 이미 멈췄으면 즉시 포기한다.
 */
function requestFlush (win, timeoutMs = FLUSH_ON_CLOSE_MS) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve()
    const wc = win.webContents
    // 사이드카가 이미 멈췄으면 저장이 갈 곳이 없다. 기다려봐야 시간만 버린다.
    if (!wc || wc.isDestroyed() || wc.isCrashed() || sidecarStopped) return resolve()
    let timer = null
    const finish = () => {
      clearTimeout(timer)
      flushWaiters.delete(wc.id)
      resolve()
    }
    flushWaiters.set(wc.id, finish)
    timer = setTimeout(finish, timeoutMs)
    wc.send('notes:flush')
  })
}

function flushAllNotes () {
  return Promise.all([...noteWindows.values()].map((win) => requestFlush(win)))
}

async function ensureAuth () {
  const { authenticated } = await sidecar.call('auth_status', { email: EMAIL_KEY })
  if (authenticated) return true

  const win = createLoginWindow(BrowserWindow)
  const token = await pollCookie(session.fromPartition('persist:login'),
                                 { intervalMs: 1000, timeoutMs: 300000 })
  win.close()
  if (!token) return false
  await sidecar.call('exchange_cookie', { email: EMAIL_KEY, oauth_token: token })
  return true
}

function createListWindow () {
  const win = new BrowserWindow({
    width: 420,
    height: 560,
    title: 'Keep 메모',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'list.html'))
  return win
}

function createNoteWindow (noteId) {
  const state = store.setNote(noteId, { visible: true })
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.w,
    height: state.h,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'note.html'))
  noteWindows.set(noteId, win)

  const persistBounds = () => {
    const b = win.getBounds()
    store.setNote(noteId, { x: b.x, y: b.y, w: b.width, h: b.height })
    store.save()
  }
  win.on('moved', persistBounds)
  win.on('resized', persistBounds)

  // OS 가 창을 닫는 경로(Alt+F4, 작업 관리자, 종료/로그오프)는 렌더러의 ✕
  // 핸들러를 거치지 않는다. 그래서 ✕ 가 하는 "닫기 전에 flush" 가 통째로
  // 건너뛰어지고 미저장 편집이 사라진다. 여기서 한 번 막고 렌더러에 저장을
  // 요청한 뒤 실제로 닫는다. 기다림은 유한하다(FLUSH_ON_CLOSE_MS).
  let flushRequested = false
  win.on('close', (e) => {
    if (flushRequested) return // 두 번째 진입 — 이번엔 진짜 닫는다
    flushRequested = true
    e.preventDefault()
    requestFlush(win).then(() => {
      if (!win.isDestroyed()) win.close()
    })
  })
  win.on('closed', () => noteWindows.delete(noteId))

  store.save()
  return win
}

function windowIdOf (event) {
  const win = BrowserWindow.fromWebContents(event.sender)
  for (const [id, w] of noteWindows) if (w === win) return id
  return null
}

app.whenReady().then(async () => {
  store = new Store(path.join(app.getPath('userData'), 'state.json'))
  store.load()
  startSidecar()

  ipcMain.handle('notes:list', () => sidecar.call('list_notes'))
  ipcMain.handle('notes:create', async (_e, title, text) => {
    const res = await sidecar.call('create_note', { title, text })
    return res.note
  })
  ipcMain.handle('auth:exchange', async (_e, token) => {
    try {
      await sidecar.call('exchange_cookie', { email: EMAIL_KEY, oauth_token: token })
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  })

  ipcMain.handle('notes:currentId', (event) => windowIdOf(event))

  // 창 하나당 리스너를 새로 달면 포스트잇이 열 장만 넘어도 리스너 누수 경고가
  // 뜬다. 리스너는 하나만 두고 보낸 쪽(webContents)으로 짝을 찾는다.
  ipcMain.on('notes:flushed', (event) => {
    const done = flushWaiters.get(event.sender.id)
    if (done) done()
  })

  ipcMain.handle('notes:open', (_e, id) => {
    const existing = noteWindows.get(id)
    if (existing) { existing.focus(); return { ok: true } }
    createNoteWindow(id)
    return { ok: true }
  })

  ipcMain.handle('notes:close', (_e, id) => {
    // 바탕화면에서 내리기만 한다. Keep 메모는 그대로 둔다.
    store.setNote(id, { visible: false })
    store.save()
    const win = noteWindows.get(id)
    if (win) win.close()
    return { ok: true }
  })

  ipcMain.handle('notes:update', async (_e, id, patch) => {
    try {
      const res = await sidecar.call('update_note', { id, text: patch.text })
      // 성공한 저장은 앞선 실패/충돌의 보관본을 무효로 만든다. 지우지 않으면
      // 노트 본문이 %APPDATA% 의 state.json 에 무기한 남는데, 이걸 보거나
      // 지우는 UI 는 Phase 2 라서 사용자는 존재조차 모른다.
      store.setNote(id, { conflictBackup: res.conflict ? res.sentText : null })
      store.save()
      return { ok: true, ...res }
    } catch (err) {
      // ipcMain.handle 이 던지면 렌더러에는 message 만 건너간다 (err.code 는
      // 사라진다). 그러면 재로그인 필요 여부를 렌더러가 알 수 없다. 그래서
      // 여기서 잡아 shape 로 돌려준다 — auth:exchange 와 같은 관례다.
      // 저장 자체가 실패했으므로 이 편집은 서버에 도달하지 못했다. 충돌과
      // 같은 방식으로 conflictBackup 에 보관해 ✕ 를 눌러도 사라지지 않게 한다.
      store.setNote(id, { conflictBackup: patch.text })
      store.save()
      return { ok: false, message: err.message, code: err.code }
    }
  })

  ipcMain.handle('notes:trash', async (_e, id) => {
    try {
      await sidecar.call('trash_note', { id })
    } catch (err) {
      return { ok: false, message: err.message, code: err.code }
    }
    store.setNote(id, { visible: false })
    store.save()
    const win = noteWindows.get(id)
    if (win) win.close()
    return { ok: true }
  })

  if (!(await ensureAuth())) {
    // 이 시점까지 창이 하나도 뜨지 않았다. window-all-closed 는 열려 있던
    // 창이 닫힐 때만 발동하므로 여기서는 절대 불리지 않는다 — 그러면
    // 사이드카(와 마스터 토큰을 쥔 Python 자식 프로세스)가 안 죽고 남아
    // 사용자가 작업 관리자로 끌 수밖에 없는 유령 프로세스가 된다.
    // 창이 없는 상태에서 실패를 반환한 쪽이 종료까지 책임진다.
    dialog.showErrorBox('Keep 연결 실패', '인증에 실패했습니다. 앱을 종료합니다.')
    stopSidecar()
    app.quit()
    return
  }
  await sidecar.call('set_account', { email: EMAIL_KEY })
  // 지난 세션에 띄워둔 포스트잇을 위치까지 복원한다.
  for (const id of store.visibleIds()) createNoteWindow(id)
  createListWindow()
})

// 정리를 window-all-closed 한 곳에만 두면 안 된다. 이 이벤트는 app.quit() 이나
// OS 종료/로그오프에서는 발동하지 않는다. 지금까지 파이썬 자식이 죽은 것은
// Electron 이 끝나며 stdin 파이프가 닫혀 serve() 루프가 빠져나온 덕이지 설계된
// 정리가 아니다 — 자식이 keep.sync() 안에서 네트워크를 기다리는 중이라면 그
// 우연은 성립하지 않고, 마스터 토큰을 쥔 유령 프로세스가 남는다.
app.on('window-all-closed', () => {
  stopSidecar()
  app.quit()
})

// app.quit() 경로. 여기서 곧장 사이드카를 죽이면 안 된다 — before-quit 은 창이
// 닫히기 '전에' 오고, 창 닫기 경로(win.on('close'))가 마지막 저장을 사이드카로
// 보내기 때문이다. 먼저 막고, 모든 포스트잇의 저장을 끝낸 뒤, 그때 정리한다.
app.on('before-quit', (e) => {
  if (quitTeardownStarted) return // 두 번째 진입 — 이번엔 진짜 종료한다
  quitTeardownStarted = true
  e.preventDefault()
  // 종료를 막아둔 상태이므로 여기서 무슨 일이 있어도 app.quit() 까지는 반드시
  // 도달해야 한다. 도달하지 못하면 사용자는 닫히지 않는 앱을 갖게 된다.
  flushAllNotes().catch(() => {}).then(() => {
    try {
      stopSidecar()
    } finally {
      app.quit()
    }
  })
})

// 위 경로를 타지 않은 종료(외부 요인, 재진입 등)에서도 반드시 정리한다.
app.on('will-quit', stopSidecar)

// Windows 종료/로그오프에서는 before-quit / will-quit 이 오지 않는다.
// 저장을 기다릴 시간도 없는 경로다. 최소한 유령 프로세스는 남기지 않는다.
app.on('session-end', stopSidecar)

module.exports = { noteWindows }
