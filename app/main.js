'use strict'
const path = require('node:path')
const { app, BrowserWindow, ipcMain, session, dialog } = require('electron')
const { Sidecar } = require('./sidecar')
const { Store } = require('./store')
const { createLoginWindow, pollCookie } = require('./login')

const EMAIL_KEY = 'you@gmail.com' // Phase 2 에서 설정 화면으로 옮긴다
const PRELOAD = path.join(__dirname, 'preload.js')

let sidecar = null
let store = null
const noteWindows = new Map() // noteId -> BrowserWindow

function startSidecar () {
  // 개발 중에는 시스템 python 을, 배포본에서는 PyInstaller 산출물을 쓴다 (Task 8).
  sidecar = new Sidecar('python', [path.join(__dirname, '..', 'keep_service.py')]).start()
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
  createListWindow()
})

app.on('window-all-closed', () => {
  if (sidecar) sidecar.stop()
  app.quit()
})

module.exports = { noteWindows }
