'use strict'
const path = require('node:path')
const { app, BrowserWindow, ipcMain, session, dialog } = require('electron')
const { Sidecar } = require('./sidecar')
const { Store } = require('./store')
const { createLoginWindow, pollCookie } = require('./login')
const { resolveSidecarCommand } = require('./sidecar-path')

const EMAIL_KEY = 'you@gmail.com' // Phase 2 에서 설정 화면으로 옮긴다
const PRELOAD = path.join(__dirname, 'preload.js')

let sidecar = null
let store = null
const noteWindows = new Map() // noteId -> BrowserWindow

function startSidecar () {
  const { command, args } = resolveSidecarCommand(app.isPackaged, process.resourcesPath, __dirname)
  sidecar = new Sidecar(command, args, {
    maxRestarts: 3,
    onDead: (message) => {
      dialog.showErrorBox('Keep 연결 끊김',
        `백그라운드 서비스가 반복해서 종료되었습니다.\n\n${message}\n\n` +
        '앱을 다시 시작해 주세요. 편집 중이던 내용은 저장되지 않았을 수 있습니다.')
    }
  }).start()
  return sidecar
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
    const res = await sidecar.call('update_note', { id, text: patch.text })
    if (res.conflict) {
      store.setNote(id, { conflictBackup: res.sentText })
      store.save()
    }
    return res
  })

  ipcMain.handle('notes:trash', async (_e, id) => {
    await sidecar.call('trash_note', { id })
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
    if (sidecar) sidecar.stop()
    app.quit()
    return
  }
  await sidecar.call('set_account', { email: EMAIL_KEY })
  // 지난 세션에 띄워둔 포스트잇을 위치까지 복원한다.
  for (const id of store.visibleIds()) createNoteWindow(id)
  createListWindow()
})

app.on('window-all-closed', () => {
  if (sidecar) sidecar.stop()
  app.quit()
})

module.exports = { noteWindows }
