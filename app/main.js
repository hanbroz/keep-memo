'use strict'
const path = require('node:path')
const electron = require('electron')
const { app, BrowserWindow, ipcMain, session, dialog, Tray, Menu, nativeImage } = electron
// screen 모듈은 app 의 ready 이후에만 쓸 수 있다. 위에서 같이 구조 분해하면
// 모듈 적재 시점(= ready 이전)에 건드리게 되므로, 쓸 때 꺼내 쓴다. 이 게터를
// 부르는 코드는 전부 ready 이후 경로(접기/펼치기/재배치)에만 있다.
const screen = () => electron.screen
const { Sidecar } = require('./sidecar')
const { Store } = require('./store')
const { createLoginWindow, pollCookie } = require('./login')
const { resolveSidecarCommand } = require('./sidecar-path')
const { validateEmail } = require('./email-validate')
const { bookmarkBounds, BOOKMARK } = require('./bookmark-layout')
const { reconcileSelection } = require('./selection-reconcile')
const { trayMenuTemplate, TRAY_TOOLTIP } = require('./tray-menu')
const { TRAY_ICON_DATA_URL } = require('./tray-icon')

// --- 다중 실행 방지 -------------------------------------------------------
//
// 반드시 파일에서 가장 먼저 하는 일이어야 한다 — whenReady() 보다도, 이메일
// 설정 창보다도, ensureAuth() 보다도, startSidecar() 보다도 앞서야 한다.
// 두 번째 인스턴스가 사이드카를 하나라도 더 띄우면 마스터 토큰으로 다시
// 인증하고 동기화하는 파이썬 자식이 하나 더 생기고, 두 프로세스가 같은
// %TEMP% 압축해제본과 같은 state.json 을 동시에 건드리게 된다 — 트레이
// 아이콘이 두 개로 늘고 창 하나가 자기 HTML 을 텍스트로 그리던, 이 수정이
// 고치려는 바로 그 증상의 원인이다.
//
// 잠금을 얻지 못했다는 것은 이미 다른 인스턴스가 실행 중이라는 뜻이다. 이
// 프로세스는 창도 트레이도 사이드카도 만들지 않고 즉시 끝나야 한다.
//
// app.quit() 을 여기서 부르고 곧장 return 하는 것이 핵심이다. 아래의
// app.whenReady() 도, before-quit / will-quit / window-all-closed /
// session-end 리스너도 이 지점 이후에 등록되므로, 잠금에 실패한 이
// 프로세스에서는 그 리스너들이 아예 등록되지 않는다. 특히 before-quit
// 핸들러(맨 아래, quitTeardownStarted 로 재진입을 막고 flushAllNotes() →
// stopSidecar() → app.quit() 순으로 도는 그 핸들러)는 리스너 목록에 없으므로
// 이 app.quit() 을 가로채 preventDefault() 를 부르거나 무언가를 기다리게
// 만들 여지가 물리적으로 없다 — Node 의 EventEmitter 는 등록된 리스너만
// 부르고, 이 프로세스는 그 리스너를 등록하는 코드에 도달하기 전에 끝난다.
// 그래서 정지할 것도, 지연될 것도 없이 즉시 종료한다. (CommonJS 모듈은
// Node 가 함수로 감싸 실행하므로 최상위 return 이 유효한 문법이다.) 이 순서는
// Electron 공식 문서가 app.requestSingleInstanceLock() 예제로 보여주는 것과
// 같다.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
  return
}

// 두 번째 인스턴스를 실행하려는 시도가 있으면(=방금 위에서 잠금에 실패한
// 프로세스가 있으면) 이 인스턴스로 알림이 온다. openOrFocusList() 는 트레이
// 클릭과 같은 진입점이다 — "앱을 또 실행했다"도 "트레이를 눌렀다"도 결국
// "보여 달라"는 같은 요청이고, 시작이 아직 끝나지 않은 동안(설정/로그인
// 창이 떠 있는 동안)의 폴백까지 이미 그 함수가 처리한다.
app.on('second-instance', () => {
  openOrFocusList()
})

const PRELOAD = path.join(__dirname, 'preload.js')
// 창을 닫기 전에 렌더러의 마지막 저장을 기다려 주는 시간. 응답 없는(혹은
// 이미 사라진) 렌더러 하나 때문에 종료가 막히면 안 되므로 반드시 유한하다.
// flush 하나를 잃는 편이 닫히지 않는 앱보다 낫다.
const FLUSH_ON_CLOSE_MS = 3000
// 펼친 직후, OS 가 뒤늦게 보내는 moved/resized 이벤트가 다 지나갈 때까지
// 기다리는 시간. 이 창이 왜 필요한지는 boundsFrozen 주석에 있다.
const UNFOLD_SETTLE_MS = 400

let sidecar = null
let store = null
let accountEmail = null
let sidecarStopped = false
let quitTeardownStarted = false
// 목록 창은 한 장뿐이다. 두 장이 뜨면 각자 다른 체크 상태를 들고 있다가
// 나중에 [완료]를 누른 쪽이 앞선 쪽의 선택을 덮어쓴다.
let listWindow = null
// 트레이 아이콘. **반드시 모듈 수명 동안 살아 있는 변수여야 한다.** Tray 를
// 만든 함수의 지역 변수로만 들고 있으면 GC 가 수거하면서 몇 분 뒤 아이콘이
// 소리 없이 사라진다 — 그러면 앱에 닿을 길이 없어져 지금 고치는 바로 그 버그로
// 되돌아간다.
let tray = null
// 사이드카와 IPC 핸들러 등록이 모두 끝났는가. 트레이는 그보다 먼저 만들어지므로
// (아래 whenReady 의 주석 참고) 준비되기 전에 눌릴 수 있다.
let startupComplete = false
const noteWindows = new Map() // noteId -> BrowserWindow
const flushWaiters = new Map() // webContents.id -> 대기 해제 함수

// 접힌 메모의 순서. 같은 모니터에 접힌 것끼리 이 순서대로 위에서 아래로 쌓인다.
// displayId 를 접을 때 함께 적어두는 이유: 접고 나면 창은 책갈피 자리로
// 옮겨가 있어서 "원래 어느 모니터에 있었나"를 창 좌표로 되물을 수 없다.
const foldOrder = [] // [{ id, displayId }]
// 지금 위치/크기를 state.json 에 쓰면 안 되는 메모들.
//
// 이것이 이 기능 전체에서 제일 조심해야 할 지점이다. createNoteWindow 는
// moved/resized 마다 창의 현재 좌표를 state.json 에 적는다. 접기는 창을
// 옮기고 줄이는 동작이므로, 막지 않으면 "펼친 상태의 좌표"가 책갈피 좌표로
// 덮여 되돌아갈 자리가 사라진다. 접는 순간부터 얼려 두고, 펼친 뒤에도 OS 가
// 늦게 보내는 이벤트가 지나갈 때까지(UNFOLD_SETTLE_MS) 계속 얼려 둔다.
const boundsFrozen = new Set() // noteId
const unfreezeTimers = new Map() // noteId -> Timeout
// 닫기를 시작했지만 아직 사라지지 않은 창들. 닫기는 즉시 끝나지 않는다 —
// win.on('close') 가 한 번 막고 렌더러의 마지막 저장을 기다린다. 그 사이에도
// 창은 noteWindows 에 남아 있으므로, 그냥 세면 방금 내린 메모가 목록 창에
// 여전히 체크된 것으로 보인다.
const closingNotes = new Set() // noteId

/** 지금 바탕화면에 실제로 올라가 있는 메모 id. 접힌 것은 포함, 닫는 중은 제외. */
function desktopIds () {
  return [...noteWindows.keys()].filter((id) => !closingNotes.has(id))
}

/**
 * 계정 이메일을 state.json 또는 환경 변수에서 구한다. 저장소(git)에는 개인
 * 정보를 두지 않는다 — 최초 실행 시 KEEP_STICKY_EMAIL 로 한 번 받으면
 * state.json 에 저장되어 다음부터는 환경 변수 없이도 동작한다.
 */
function resolveEmail (store) {
  const stored = store.getEmail()
  if (stored) return stored
  const fromEnv = process.env.KEEP_STICKY_EMAIL
  if (!fromEnv) return null
  store.setEmail(fromEnv)
  store.save()
  return fromEnv
}

function createSetupEmailWindow () {
  const win = new BrowserWindow({
    width: 500,
    height: 360,
    title: 'Keep 계정 설정',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'setup-email.html'))
  return win
}

/**
 * 이메일을 아직 구하지 못했을 때(최초 실행) 창을 띄워 사용자에게 직접 받는다.
 * 반드시 startSidecar() 보다 먼저 불러야 한다 — 그래야 사용자가 창을 그냥
 * 닫아도 정리할 사이드카가 없어(마스터 토큰을 쥔 유령 프로세스가 애초에
 * 생기지 않아) 종료가 항상 깨끗하다.
 *
 * 입력이 검증을 통과하면 store 에 저장하고 창을 닫은 뒤 이메일 문자열을
 * 반환한다. 사용자가 아무것도 입력하지 않고 창을 닫으면 null 을 반환한다 —
 * 이후 종료 처리는 호출자(app.whenReady())의 책임이다.
 */
function promptForEmail (store) {
  return new Promise((resolve) => {
    const win = createSetupEmailWindow()
    let settled = false
    const finish = (email) => {
      if (settled) return // ipc 성공 경로와 창 닫힘 경로가 겹쳐 불릴 수 있다
      settled = true
      ipcMain.removeHandler('setup:submitEmail')
      resolve(email)
    }

    ipcMain.handle('setup:submitEmail', (_e, rawEmail) => {
      const result = validateEmail(rawEmail)
      if (!result.ok) return { ok: false, message: result.message }
      store.setEmail(result.value)
      store.save()
      finish(result.value)
      if (!win.isDestroyed()) win.close()
      return { ok: true }
    })

    // 사용자가 ✕ 로 취소하든, 위에서 성공 후 우리가 close() 를 부르든 결국
    // 여기로 온다. finish 는 멱등하므로 어느 쪽이 먼저 와도 안전하다.
    win.on('closed', () => finish(null))
  })
}

function startSidecar () {
  const { command, args } = resolveSidecarCommand(app.isPackaged, process.resourcesPath, __dirname)
  sidecar = new Sidecar(command, args, {
    maxRestarts: 3,
    // 재시작된 파이썬 프로세스는 set_account 이전 상태다. 여기서 다시 세우지
    // 않으면 이후 모든 호출이 AUTH_REQUIRED 로 떨어지고, 재로그인해도 낫지
    // 않는다 — 즉 "재시작 3회"가 죽음을 감추면서 고장을 확정짓는다.
    onRestart: (s) => s.call('set_account', { email: accountEmail }),
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
  const { authenticated } = await sidecar.call('auth_status', { email: accountEmail })
  if (authenticated) return true

  const win = createLoginWindow(BrowserWindow)
  const token = await pollCookie(session.fromPartition('persist:login'),
                                 { intervalMs: 1000, timeoutMs: 300000 })
  win.close()
  if (!token) return false
  await sidecar.call('exchange_cookie', { email: accountEmail, oauth_token: token })
  return true
}

/**
 * 목록 창을 띄운다. 이미 있으면 새로 만들지 않고 앞으로 가져오기만 한다
 * (createNoteWindow 와 같은 관례다). 트레이에서 몇 번을 눌러도 창은 한 장이다.
 */
function createListWindow () {
  if (listWindow && !listWindow.isDestroyed()) {
    if (listWindow.isMinimized()) listWindow.restore()
    listWindow.show()
    listWindow.focus()
    return listWindow
  }

  const win = new BrowserWindow({
    width: 460,
    height: 620,
    minWidth: 360,
    minHeight: 320,
    title: 'Keep 메모',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  listWindow = win
  win.loadFile(path.join(__dirname, 'renderer', 'list.html'))
  // 창이 실제로 사라진 뒤에 참조를 놓는다. 여기서 지우지 않으면 다음 열기가
  // 죽은 창을 앞으로 가져오려다 아무 일도 안 하게 되고, 목록이 영영 안 뜬다.
  // 남의 항목을 지우지 않도록 동일성을 확인한다(createNoteWindow 와 같다).
  win.on('closed', () => {
    if (listWindow === win) listWindow = null
  })
  return win
}

/**
 * 트레이 클릭과 두 번째 인스턴스 실행, 둘 다에서 목록 창을 여는 유일한
 * 진입점.
 *
 * 시작이 끝나기 전에는 목록 창을 만들지 않는다. 그 시점에는 notes:list 같은
 * IPC 핸들러가 아직 없어서, 만들어봐야 아무것도 못 불러오는 빈 창이 뜬다.
 * 대신 지금 떠 있는 창(최초 실행 설정 창이나 로그인 창)을 앞으로 가져온다 —
 * 사용자가 트레이를 누르든 exe 를 한 번 더 누르든, 이유는 결국 "앱을 보여
 * 달라"이기 때문이다.
 */
function openOrFocusList () {
  if (!startupComplete) {
    const [win] = BrowserWindow.getAllWindows()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    return
  }
  createListWindow()
}

/**
 * 트레이 아이콘을 만든다. 실패하면 던진다 — 부르는 쪽(ensureTray)이 처리한다.
 *
 * 아이콘 픽셀은 파일이 아니라 소스(tray-icon.js)의 base64 문자열에서 온다.
 * 이유는 그 파일의 주석에 있다(요약: 배포본의 app.asar 안 경로를 이미지
 * 로더가 못 읽는 경우가 있고, 그러면 아이콘이 비어 앱이 통째로 안 보인다).
 */
function createTray () {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  // 디코드에 실패해도 nativeImage 는 던지지 않고 '빈 이미지'를 준다. 그대로
  // Tray 에 넘기면 알림 영역에 아무것도 안 보이는 트레이가 생긴다 — 있으나
  // 마나 한 정도가 아니라, "창이 없어도 된다"의 근거가 거짓이 된다.
  if (icon.isEmpty()) throw new Error('트레이 아이콘 PNG 를 디코드하지 못했다')

  const t = new Tray(icon)
  t.setToolTip(TRAY_TOOLTIP)
  t.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate({
    onOpenList: openOrFocusList,
    // 트레이의 [종료]도 반드시 app.quit() 을 거친다. 미저장 편집 flush 와
    // 사이드카 정리는 전부 before-quit / will-quit 에 있고, 그 경로를
    // 건너뛰면 편집이 소리 없이 사라지고 파이썬 자식이 살아남는다.
    onQuit: () => app.quit()
  })))
  // 왼쪽 클릭. Windows 에서 오른쪽 클릭은 위 컨텍스트 메뉴가 받는다.
  t.on('click', openOrFocusList)
  return t
}

/**
 * 트레이를 세운다. 멱등하고, 실패해도 앱을 죽이지 않는다.
 *
 * 실패하면 tray 는 null 로 남는다. 그 상태에서는 window-all-closed 가 예전처럼
 * 앱을 끝내므로(아래 참고) 최악의 경우에도 "보이지도 않고 죽지도 않는 앱"은
 * 생기지 않는다 — 목록 창을 닫으면 앱이 같이 끝나는, 고치기 전의 동작으로
 * 돌아갈 뿐이다.
 */
function ensureTray () {
  if (tray && !tray.isDestroyed()) return tray
  try {
    tray = createTray()
  } catch (err) {
    console.warn(`트레이 아이콘을 만들지 못했다: ${err.message}`)
    tray = null
  }
  return tray
}

/** 트레이 아이콘이 지금 화면에 있는가. 창 없이 살아 있어도 되는 유일한 근거다. */
function trayAlive () {
  return !!tray && !tray.isDestroyed()
}

function createNoteWindow (noteId) {
  // 같은 메모의 창을 두 장 만들면 noteWindows 의 항목이 서로를 덮어쓰고,
  // 먼저 닫히는 쪽의 'closed' 가 남은 쪽의 항목을 지워 창을 미아로 만든다.
  // 이미 있으면 앞으로 가져오기만 한다.
  const existing = noteWindows.get(noteId)
  if (existing && !existing.isDestroyed()) { existing.focus(); return existing }

  // 펼친 상태의 기하로 만든다. 접힌 채 저장된 메모라도 창은 일단 제자리에
  // 만들고 아래에서 접는다 — 그래야 펼칠 자리가 창에도 스토어에도 남는다.
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
    // 접혀 있는 동안(그리고 막 펼친 직후)의 좌표는 책갈피의 것이지 메모의
    // 것이 아니다. 여기서 적으면 펼칠 자리를 잃는다.
    if (boundsFrozen.has(noteId)) return
    if (win.isDestroyed()) return
    const b = win.getBounds()
    store.setNote(noteId, { x: b.x, y: b.y, w: b.width, h: b.height })
    store.save()
  }
  win.on('moved', persistBounds)
  win.on('resized', persistBounds)

  // 렌더러는 자기가 접혀 있는지 모르는 채로 뜬다. 로드가 끝나는 시점에 알려야
  // 재시작 복원(접힌 채 저장된 메모)에서도 책갈피 모습으로 그려진다.
  win.webContents.on('did-finish-load', () => sendFoldState(noteId))

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
  win.on('closed', () => {
    // 위 중복 방지 덕에 보통은 항상 참이지만, 지도에서 지우기 전에 확인한다 —
    // 남의 항목을 지우면 살아 있는 창이 미아가 된다.
    if (noteWindows.get(noteId) === win) noteWindows.delete(noteId)
    closingNotes.delete(noteId)
    // 접힌 채로 닫힌 메모는 책갈피 줄에서 빠지고, 아래 것들이 빈자리를 메운다.
    forgetFold(noteId)
    relayoutBookmarks()
  })

  store.save()
  // 지난 세션에 접힌 채로 끝난 메모는 여기서 다시 접는다. 창이 이미 펼친
  // 기하로 만들어졌으므로 접기 경로가 그 값을 그대로 보존한다.
  if (state.folded) foldNote(noteId)
  return win
}

function windowIdOf (event) {
  const win = BrowserWindow.fromWebContents(event.sender)
  for (const [id, w] of noteWindows) if (w === win) return id
  return null
}

// --- 접기 / 펼치기 --------------------------------------------------------

function sendFoldState (noteId) {
  const win = noteWindows.get(noteId)
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return
  wc.send('notes:foldState', isFolded(noteId))
}

function isFolded (noteId) {
  return foldOrder.some((e) => e.id === noteId)
}

function forgetFold (noteId) {
  const i = foldOrder.findIndex((e) => e.id === noteId)
  if (i >= 0) foldOrder.splice(i, 1)
  clearTimeout(unfreezeTimers.get(noteId))
  unfreezeTimers.delete(noteId)
  boundsFrozen.delete(noteId)
}

/**
 * 접힌 메모들을 모니터별로 오른쪽 가장자리에 다시 줄 세운다. 접을 때와 펼칠
 * 때 모두 부른다 — 하나가 펼쳐지면 그 아래 것들이 빈자리를 메워야 한다.
 */
function relayoutBookmarks () {
  const usedSlots = new Map() // displayId -> 이미 채운 칸 수
  const displays = screen().getAllDisplays()
  for (const entry of foldOrder) {
    const win = noteWindows.get(entry.id)
    if (!win || win.isDestroyed()) continue
    const slot = usedSlots.get(entry.displayId) || 0
    usedSlots.set(entry.displayId, slot + 1)
    // 접은 뒤에 모니터를 뽑았을 수 있다. 그 경우 주 모니터로 데려온다 —
    // 없는 화면에 붙여두면 사용자가 영영 못 찾는다.
    const display = displays.find((d) => d.id === entry.displayId) || screen().getPrimaryDisplay()
    win.setBounds(bookmarkBounds(display.workArea, slot, BOOKMARK))
  }
}

/**
 * 메모를 책갈피로 접는다. 미저장 편집은 렌더러가 접기 버튼에서 먼저 flush 한
 * 뒤에 이 경로로 들어온다 (note.js 의 ✕ 와 같은 순서다).
 */
function foldNote (noteId) {
  const win = noteWindows.get(noteId)
  if (!win || win.isDestroyed()) return false
  if (isFolded(noteId)) return true

  // 접기 전의 진짜 기하를 먼저 확정한다. 이 한 줄이 "펼치면 돌아갈 자리"다.
  const b = win.getBounds()
  store.setNote(noteId, { x: b.x, y: b.y, w: b.width, h: b.height, folded: true })
  store.save()

  // 지금 이 창이 올라가 있는 모니터. 주 모니터가 아니라 여기에 붙어야 한다.
  const displayId = screen().getDisplayMatching(b).id

  // 얼리는 것이 창을 옮기는 것보다 반드시 먼저다.
  boundsFrozen.add(noteId)
  clearTimeout(unfreezeTimers.get(noteId))
  unfreezeTimers.delete(noteId)
  foldOrder.push({ id: noteId, displayId })

  // 책갈피는 44px 짜리 띠다. 테두리를 잡아 끄는 실수로 찌그러지지 않게 한다.
  win.setResizable(false)
  relayoutBookmarks()
  sendFoldState(noteId)
  return true
}

/** 책갈피를 접기 직전의 위치와 크기 그대로 되돌린다. */
function unfoldNote (noteId) {
  if (!isFolded(noteId)) return false
  const win = noteWindows.get(noteId)

  const i = foldOrder.findIndex((e) => e.id === noteId)
  foldOrder.splice(i, 1)
  const state = store.setNote(noteId, { folded: false })
  store.save()

  if (win && !win.isDestroyed()) {
    win.setResizable(true)
    win.setBounds({ x: state.x, y: state.y, width: state.w, height: state.h })
  }
  // 아직 얼어 있는 채로 알린다. 위 setBounds 가 만드는 moved/resized 는 물론
  // 접을 때 큐에 남아 있던 이벤트까지 다 지나간 뒤에 녹인다. 늦게 도착한
  // 책갈피 좌표 한 개가 state.json 에 적히면 다음 펼치기가 망가진다.
  sendFoldState(noteId)
  clearTimeout(unfreezeTimers.get(noteId))
  unfreezeTimers.set(noteId, setTimeout(() => {
    unfreezeTimers.delete(noteId)
    boundsFrozen.delete(noteId)
  }, UNFOLD_SETTLE_MS))

  relayoutBookmarks() // 아래 책갈피들이 빈자리를 메운다
  return true
}

/**
 * 바탕화면에서만 내린다. Keep 메모는 손대지 않는다 — 이 함수에서 trash_note
 * 로 가는 길은 없고, 있어서도 안 된다. 삭제는 포스트잇 우클릭 → 확인 경로뿐이다.
 */
function hideNote (id) {
  // 다시 체크해서 띄울 때는 펼친 포스트잇으로 돌아온다. 바탕화면에 없는
  // 메모가 "접혀 있다"고 기억할 이유가 없고, 눈에 잘 띄지 않는 책갈피로
  // 되살아나면 사용자는 아무 일도 안 일어났다고 느낀다.
  store.setNote(id, { visible: false, folded: false })
  store.save()
  const win = noteWindows.get(id)
  // foldOrder / boundsFrozen 정리는 'closed' 에서 한다. 창이 실제로 사라지기
  // 전까지는 얼어 있어야 닫는 도중의 이벤트가 좌표를 덮지 않는다.
  if (win && !win.isDestroyed()) {
    closingNotes.add(id)
    win.close()
  }
}

app.whenReady().then(async () => {
  store = new Store(path.join(app.getPath('userData'), 'state.json'))
  store.load()

  // 트레이를 시작의 맨 앞에서 세우는 이유는 편의가 아니라 안전이다. 시작
  // 과정에는 창이 0 장인 순간이 여러 번 있다 — 설정 창을 닫은 뒤 로그인 창이
  // 뜨기 전, 로그인 창을 닫은 뒤 포스트잇을 복원하기 전. 트레이가 없으면 그
  // 순간마다 window-all-closed 가 발동해 멀쩡히 진행 중인 시작을 끝내버린다.
  //
  // 반대 방향의 위험(트레이가 있어서 종료가 막히는 것)은 없다. 아래의 두
  // 조기 종료 경로는 window-all-closed 에 기대지 않고 직접 app.quit() 을
  // 부르며, app.quit() 은 트레이 유무와 무관하게 종료를 끝까지 진행한다.
  ensureTray()

  accountEmail = resolveEmail(store)
  if (!accountEmail) {
    // 저장된 값도 환경 변수도 없다 — 최초 실행이다. 사이드카는 아직 시작하지
    // 않았으므로(아래 startSidecar() 호출 전) 사용자가 창을 그냥 닫아도 정리할
    // 대상이 없다. 이 순서를 지키는 것이 유령 프로세스를 막는 핵심이다.
    accountEmail = await promptForEmail(store)
  }
  if (!accountEmail) {
    // 사용자가 이메일을 입력하지 않고 설정 창을 닫았다. ensureAuth 실패
    // 경로와 같은 모양(대화상자 → 사이드카 정리 → quit → return)을 유지해
    // 종료 경로를 하나로 둔다 — 창이 하나도 없는 상태에서 조용히 return 하면
    // 앱이 남는다. 트레이가 생긴 뒤로는 그것이 더 확실해졌다: window-all-closed
    // 는 트레이가 살아 있는 동안 앱을 끝내지 않으므로, 여기서 명시적으로 부르는
    // app.quit() 이 이 경로의 유일한 종료 수단이다. app.quit() 은 트레이가
    // 있어도 before-quit → will-quit 을 거쳐 끝까지 진행하며, will-quit 에서
    // 사이드카를 다시 한 번 정리하고 트레이 아이콘도 지운다.
    dialog.showErrorBox('Keep 계정 설정 필요',
      '이메일을 입력하지 않아 앱을 종료합니다.\n다시 실행하면 설정 창이 다시 열립니다.')
    stopSidecar()
    app.quit()
    return
  }

  startSidecar()

  ipcMain.handle('notes:list', () => sidecar.call('list_notes'))
  ipcMain.handle('notes:create', async (_e, title, text) => {
    const res = await sidecar.call('create_note', { title, text })
    return res.note
  })
  ipcMain.handle('auth:exchange', async (_e, token) => {
    try {
      await sidecar.call('exchange_cookie', { email: accountEmail, oauth_token: token })
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

  // createNoteWindow 가 이미 있는 창은 앞으로 가져오기만 한다.
  ipcMain.handle('notes:open', (_e, id) => {
    createNoteWindow(id)
    return { ok: true }
  })

  ipcMain.handle('notes:close', (_e, id) => {
    // 바탕화면에서 내리기만 한다. Keep 메모는 그대로 둔다.
    hideNote(id)
    return { ok: true }
  })

  // 목록 창이 체크 상자의 초기 상태를 그리는 데 쓴다. "바탕화면에 있는가"의
  // 진실은 실제로 떠 있는 창들이다 — 접힌 메모도 창이 있으므로 포함된다.
  ipcMain.handle('notes:visibleIds', () => desktopIds())

  // 목록 창의 [완료]. 체크된 집합이 곧 바탕화면에 있어야 할 집합이다.
  ipcMain.handle('notes:applySelection', (_e, checkedIds) => {
    const { toOpen, toClose } = reconcileSelection(desktopIds(), checkedIds)
    // 체크 해제는 내리기다. 지우기가 아니다.
    for (const id of toClose) hideNote(id)
    for (const id of toOpen) createNoteWindow(id)
    return { ok: true, opened: toOpen.length, closed: toClose.length }
  })

  ipcMain.handle('notes:fold', (_e, id) => ({ ok: foldNote(id) }))
  ipcMain.handle('notes:unfold', (_e, id) => ({ ok: unfoldNote(id) }))

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
    hideNote(id)
    return { ok: true }
  })

  if (!(await ensureAuth())) {
    // 이 시점에 남아 있는 창이 없다(로그인 창은 ensureAuth 안에서 닫힌다).
    // 그리고 트레이가 살아 있으므로 window-all-closed 는 앱을 끝내지 않는다.
    // 즉 여기서 조용히 return 하면 사이드카(와 마스터 토큰을 쥔 Python 자식
    // 프로세스)가 안 죽고 남아, 사용자가 작업 관리자로 끌 수밖에 없는 유령
    // 프로세스가 된다. 아이콘만 남고 뒤에 아무것도 없는 트레이는 그보다 더
    // 나쁘다. 실패를 반환한 쪽이 종료까지 책임진다.
    dialog.showErrorBox('Keep 연결 실패', '인증에 실패했습니다. 앱을 종료합니다.')
    stopSidecar()
    app.quit()
    return
  }
  await sidecar.call('set_account', { email: accountEmail })
  // 여기부터는 IPC 핸들러와 사이드카 세션이 모두 준비됐다. 트레이 메뉴가
  // 목록 창을 만들어도 되는 것은 이 줄 이후부터다.
  startupComplete = true
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
  // 트레이 아이콘이 화면에 있으면 "창이 0 장"은 정상 상태다 — 사용자는 목록
  // 창을 닫은 것이지 앱을 끝낸 것이 아니다. 앱은 트레이에서 계속 산다.
  //
  // 조건이 "트레이를 만들려고 했는가"가 아니라 "트레이가 지금 살아 있는가"인
  // 것이 핵심이다. 원래의 유령 프로세스 버그가 나빴던 이유는 화면에 앱이 살아
  // 있다는 표시가 하나도 없다는 것이었다. 창 없이 사는 것이 허용되는 근거는
  // 오직 보이는 아이콘 하나뿐이므로, 그 아이콘이 없으면 근거도 없다 —
  // 아이콘 생성에 실패했거나 이미 정리된 뒤라면 예전처럼 앱을 끝낸다.
  if (trayAlive()) return
  stopSidecar()
  app.quit()
})

// app.quit() 경로. 여기서 곧장 사이드카를 죽이면 안 된다 — before-quit 은 창이
// 닫히기 '전에' 오고, 창 닫기 경로(win.on('close'))가 마지막 저장을 사이드카로
// 보내기 때문이다. 먼저 막고, 모든 포스트잇의 저장을 끝낸 뒤, 그때 정리한다.
//
// 다중 실행 잠금에 실패해 곧장 app.quit() 하고 return 하는 경로(파일 맨 위)는
// 이 리스너 자체가 등록되기 전에 끝나므로 여기 들어올 일이 없다. 혹시 나중에
// 코드가 재배치되어 그 경로가 이 리스너보다 먼저 등록되더라도, noteWindows 와
// sidecar 가 둘 다 비어 있는 상태에서 부르는 것이므로 아래 flushAllNotes() 는
// 즉시 끝나고 stopSidecar() 는 아무 일도 하지 않는다 — 멈추거나 기다릴 것이
// 없다.
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
// 사이드카 정리가 먼저다 — 트레이 아이콘 하나 때문에 파이썬 자식이 남는 일은
// 없어야 한다.
app.on('will-quit', () => {
  stopSidecar()
  // Windows 는 프로세스가 사라진 뒤에도 알림 영역에 죽은 아이콘을 남겨두는 일이
  // 있다(마우스를 올려야 그제야 사라진다). 종료했는데 아이콘이 남아 있으면
  // 사용자는 앱이 아직 살아 있다고 읽는다. 명시적으로 지운다.
  if (trayAlive()) tray.destroy()
  tray = null
})

// Windows 종료/로그오프에서는 before-quit / will-quit 이 오지 않는다.
// 저장을 기다릴 시간도 없는 경로다. 최소한 유령 프로세스는 남기지 않는다.
app.on('session-end', stopSidecar)

module.exports = { noteWindows }
