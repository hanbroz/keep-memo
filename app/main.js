'use strict'
const path = require('node:path')
const fs = require('node:fs')
const electron = require('electron')
const { app, BrowserWindow, ipcMain, session, dialog, Tray, Menu, nativeImage, shell } = electron
// screen 모듈은 app 의 ready 이후에만 쓸 수 있다. 위에서 같이 구조 분해하면
// 모듈 적재 시점(= ready 이전)에 건드리게 되므로, 쓸 때 꺼내 쓴다. 이 게터를
// 부르는 코드는 전부 ready 이후 경로(접기/펼치기/재배치)에만 있다.
const screen = () => electron.screen
const { Sidecar } = require('./sidecar')
const { Store } = require('./store')
const { createLoginWindow, pollCookie } = require('./login')
const { resolveSidecarCommand } = require('./sidecar-path')
const { validateEmail } = require('./email-validate')
const { packBookmarks, bookmarkAnchorFromDrop, BOOKMARK } = require('./bookmark-layout')
const { reconcileSelection } = require('./selection-reconcile')
const { orphanedNoteIds } = require('./sync-reconcile')
const { validateNotePatch, validateChecklistPatch } = require('./note-patch')
// Ctrl+클릭으로 연 주소를 **여기서 다시 검증한다.** 렌더러도 같은 함수를 쓰지만
// (즉시 안내를 띄우기 위해서다), 렌더러는 신뢰 경계의 바깥쪽이라 그쪽 검사만으로는
// 검사가 아니다. shell.openExternal() 은 문자열을 그대로 운영체제에 넘기고, 그
// 문자열의 출처는 Keep 이라는 외부 데이터다.
const { sanitizeUrl, keepListUrl } = require('./renderer/url-open')
const { decideUpdate } = require('./update-check')
const { trayMenuTemplate, TRAY_TOOLTIP } = require('./tray-menu')
const { TRAY_ICON_DATA_URL } = require('./tray-icon')
const {
  extractIncomingVersion,
  describeVersionMismatch,
  decideQuitAction,
  describeQuitAction
} = require('./version-notice')

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
// additionalData 로 이 인스턴스의 버전을 함께 건다. app.getVersion() 은
// package.json 의 version(빌드마다 scripts/build.js 가 --config.extraMetadata.
// version 으로 "yyyy.MMdd.HHmm" 값을 심는다)을 읽을 뿐이라 whenReady() 이전
// 시점(지금 여기)에도 안전하다 — Electron 공식 타입 선언(electron.d.ts)에서도
// getSystemLocale() 같은 다른 메서드에는 "이 API 는 ready 이후에만 호출 가능"
// 이라는 주석이 붙어 있는데 getVersion() 에는 그런 제약이 없다.
//
// execPath 도 함께 건다 — 잠금을 이미 쥔(먼저 실행 중인) 인스턴스가 나중에
// "종료하고 새 버전을 실행"하려면, 지금 이 프로세스가 실제로 어떤 exe 였는지를
// 알아야 하기 때문이다. 이 프로세스는 잠금 획득에 실패하면 바로 아래에서 죽으므로
// (그리고 죽은 뒤에는 아무것도 못 하므로) 그 정보를 알릴 수 있는 유일한 시점이
// 지금이다. process.env.PORTABLE_EXECUTABLE_FILE 은 electron-builder 의 portable
// 타겟(app-builder-lib/templates/nsis/portable.nsi)이 압축을 풀기 전에 원본
// exe 경로($EXEPATH, = 사용자가 두 번 클릭한 KeepSticky-*.exe)로 설정해 두는
// 환경 변수다 — process.execPath(=%TEMP% 밑 압축 해제본)와 다르다. 포터블
// 빌드가 아닌 실행(예: npm start)에는 이 환경 변수가 없으므로 null 을 보낸다 —
// version-notice.js 의 extractRelaunchExecPath 가 그 경우를 "재실행 불가"로
// 다룬다.
const gotSingleInstanceLock = app.requestSingleInstanceLock({
  version: app.getVersion(),
  execPath: process.env.PORTABLE_EXECUTABLE_FILE || null
})
if (!gotSingleInstanceLock) {
  app.quit()
  return
}

// 두 번째 인스턴스를 실행하려는 시도가 있으면(=방금 위에서 잠금에 실패한
// 프로세스가 있으면) 이 인스턴스로 알림이 온다.
//
// 잠금은 appId 로 걸리고 appId 는 빌드마다 바뀌지 않는다 — 바뀌는 것은
// app.getVersion() 뿐이다. 그래서 사용자가 새로 빌드한 exe 를 실행해도, 그보다
// 오래된 인스턴스가 아직 떠 있으면 잠금은 여전히 그 오래된 인스턴스가 쥐고
// 있다: 방금 실행한 새 빌드는 여기(둘째 인자 없이 예전처럼 openOrFocusList()
// 만 불렀다면) 조용히 죽고, 오래된 인스턴스는 자기 창을 앞으로 가져올 뿐이다.
// 사용자 눈에는 "새로 빌드했는데 그대로다"로 보이지만 실제로는 새 빌드가 뜬
// 적조차 없다 — 이 블록이 고치는 증상이다.
//
// 그래서 버전이 같을 때만 조용히 넘어간다(예전과 같은 동작: 트레이 클릭과
// 같은 "보여 달라" 요청으로 보고 openOrFocusList() 하나로 끝낸다 — 시작이
// 아직 끝나지 않은 동안의 폴백도 이미 그 함수 안에 있다). 버전이 다르면(또는
// 상대가 이 기능이 없는 옛 빌드라 버전을 아예 안 보내면) 조용히 넘어가는 대신
// 지금 실행 중인 이 인스턴스가 그 사실을 다이얼로그로 알린다.
//
// "같은가/다른가"와 "다르면 뭐라고 보여줄 것인가"의 판단 자체는 Electron 없이
// 테스트 가능한 순수 함수(version-notice.js)에 있다. 여기서는 additionalData
// 를 건네고 결과에 따라 분기만 한다.
//
// decideQuitAction 도 여기서 미리 정해 둔다(다이얼로그를 띄우기 전에) — 사용자가
// 버튼을 누른 뒤가 아니라 누르기 전에 "누르면 무슨 일이 일어나는지"를 다이얼로그
// 문구에 반영해야 하기 때문이다(아래 showVersionMismatchDialog). fs.existsSync
// 를 여기서 넘기는 것이 이 프로세스에서 유일하게 파일시스템에 접근하는 지점이다 —
// version-notice.js 는 여전히 fs 를 모른다.
app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
  const incomingVersion = extractIncomingVersion(additionalData)
  const result = describeVersionMismatch(app.getVersion(), incomingVersion)
  if (result.matches) {
    openOrFocusList()
    return
  }
  const quitAction = decideQuitAction(additionalData, fs.existsSync)
  showVersionMismatchDialog(result, quitAction)
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
// 이번 실행에서 "이제 없다"고 확인된 메모 id. 여기 들어온 id 로는 update_note 가
// 더 이상 나가지 않는다. 두 경로로 채워진다:
//   1) 이 앱에서 trash_note 를 불러 방금 Keep 휴지통으로 보낸 경우.
//   2) [동기화] 가 받아온 최신 목록에 없어서(다른 기기가 지웠거나 트래시로
//      보낸 경우) 고아로 판정된 경우 — orphanedNoteIds() 가 이 판정을 한다.
// 둘 다 결과는 같다: 이 세션에서는 그 노트가 더 이상 존재하지 않으므로 그
// id 로의 저장은 사이드카까지 갈 필요 없이 여기서 막는다.
//
// 왜 필요한가: trash/고아 판정이 나면 곧바로 hideNote() 가 창을 닫고, 그
// 닫기 경로는 렌더러에 마지막 flush 를 요청한다. 렌더러도 자기 저장 경로를
// 잠그지만(note.js 의 trashCurrentNote), 잠그기 전에 이미 걸려 있던 요청이나
// 앞으로 생길 어떤 경로가 하나라도 새면 이미 없는 메모로 저장이 날아가
// NOT_FOUND 를 받거나, 그 실패분이 conflictBackup 에 남는다 — 존재하지 않는
// 메모의 본문이 state.json 에 남는 것이다. 렌더러 하나만 믿지 않고 main 에서도
// 막는다.
const trashedNotes = new Set() // noteId

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
function stopSidecar (reason = '이유 없음') {
  sidecarStopped = true
  // 부른 쪽의 이름을 남긴다. 정지된 뒤에 온 요청의 오류 문구에 그대로 실려,
  // "누가 사이드카를 세웠는가"를 화면만 보고 알 수 있다 — 실제로 그 정보가
  // 없어서 원인을 못 좁힌 적이 있다.
  if (sidecar) sidecar.stop(reason)
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

/**
 * 구글 로그인 창을 띄워 새 master token 을 받아 keyring 에 넣는다.
 *
 * **먼저 persist:login 파티션을 비우는 것이 핵심이다.** pollCookie 는 그 세션에
 * 남아 있는 oauth_token 쿠키를 그대로 집어 오는데, 그 값은 1회용이고 약 60초
 * 만에 만료된다(login.js 의 주석). 지난 로그인이 남긴 쿠키가 있으면 창이 뜨자마자
 * 이미 써 버린 그 토큰이 잡혀 exchange_cookie 가 실패한다 — 사용자에게는 "로그인
 * 창이 떴다가 그냥 실패하는" 것으로 보이고, 몇 번을 다시 눌러도 같다. 재로그인이
 * 생기면서 처음으로 문제가 되는 지점이라 여기 한 곳에서 지우고 시작한다.
 *
 * @returns {Promise<boolean>} 새 토큰을 받아 저장했는가.
 */
async function doLogin () {
  const loginSession = session.fromPartition('persist:login')
  await loginSession.clearStorageData()
  const win = createLoginWindow(BrowserWindow)
  try {
    const token = await pollCookie(loginSession, { intervalMs: 1000, timeoutMs: 300000 })
    if (!token) return false
    await sidecar.call('exchange_cookie', { email: accountEmail, oauth_token: token })
    return true
  } finally {
    // 어떤 경로로 끝나든 로그인 창은 닫는다. 사용자가 이미 ✕ 로 닫았을 수 있다.
    if (!win.isDestroyed()) win.close()
  }
}

// 로그인 창이 이미 떠 있는가. 재로그인은 트레이 메뉴와 [동기화] 실패 두 곳에서
// 들어오므로, 두 번째 요청이 창을 하나 더 띄우지 않게 막는다. 창이 두 장이면
// 둘 다 같은 쿠키를 노려 하나는 반드시 죽은 토큰을 집는다.
let loginInFlight = null

function runLoginFlow () {
  if (loginInFlight) return loginInFlight
  loginInFlight = doLogin().finally(() => { loginInFlight = null })
  return loginInFlight
}

async function ensureAuth () {
  const { authenticated } = await sidecar.call('auth_status', { email: accountEmail })
  // auth_status 는 토큰이 **있는지**만 본다(유효한지는 네트워크를 타야 안다).
  // 그래서 저장된 토큰이 구글에서 무효가 된 경우는 여기서 걸러지지 않고, 첫
  // Keep 호출이 AUTH_REQUIRED 로 떨어진다 — 그때의 통로가 notes:relogin 이다.
  if (authenticated) return true
  return runLoginFlow()
}

/**
 * 목록 창의 제목. 어느 빌드가 도는지 눈에 보이게 버전을 붙인다.
 *
 * 화면에 버전이 없으면 "업데이트했는데 그대로다" 같은 상황에서 무엇이 도는지
 * 확인할 길이 창 제목 말고는 없다 — 작업 관리자의 프로세스 이름은 포터블
 * 래퍼의 파일 이름일 뿐이라 실제로 실행 중인 빌드와 다를 수 있다.
 *
 * 개발 실행에는 빌드 스탬프가 없다. 그때는 그 사실을 드러낸다 — 개발본을
 * 릴리즈본으로 착각하는 것이 그 반대보다 위험하다.
 */
function listWindowTitle () {
  const stamp = currentBuildStamp()
  return stamp ? `Keep 메모 - ver. ${stamp}` : 'Keep 메모 - 개발 중'
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
    title: listWindowTitle(),
    // list.html 의 --paper 와 같은 값. 이것이 없으면 첫 그림이 그려지기 전까지
    // 흰 사각형이 번쩍이는데, 종이색 창에서는 그 한 순간이 눈에 띈다.
    backgroundColor: '#f2ede3',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  listWindow = win
  // list.html 의 <title> 이 창 제목을 덮어써 버전이 지워지는 것을 막는다.
  // 페이지가 제목을 바꾸려 할 때마다 거절하고 우리 것을 유지한다.
  win.on('page-title-updated', (e) => { e.preventDefault() })
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
 * 두 번째 인스턴스가 실행됐는데 버전이 다를 때(또는 상대 버전을 모를 때) 뜨는
 * 다이얼로그. 무엇을 보여줄지(message/detail)는 version-notice.js 의 순수
 * 함수가 이미 정해서 넘겨준다 — 여기서는 그것을 그대로 띄우고 사용자의 선택에
 * 따른 동작만 담당한다. 버튼 라벨과 detail 뒤에 붙는 안내 문장은 quitAction
 * (decideQuitAction 의 결과)에 따라 달라진다 — describeQuitAction 이 정한다.
 *
 * 특정 창에 매달지 않는다 — dialog.showMessageBox 에 BrowserWindow 를 넘기지
 * 않는다. listWindow 는 사용자가 이미 닫아뒀을 수 있고(트레이에만 남아 있는
 * 상태), 창에 매단 다이얼로그는 그 창이 안 보이면 같이 안 보이게 된다. Electron
 * 문서(showMessageBoxSync 설명): 창을 안 주거나 준 창이 안 보이면 "독립 창으로
 * 뜬다" — 이 다이얼로그가 바로 그래야 한다. 여기에 더해 app.focus({ steal:
 * true }) 로 이 앱을 최상단으로 끌어와, 사용자가 다른 앱을 보고 있던 중이었어도
 * 다이얼로그가 뜨자마자 눈에 들어오게 한다. second-instance 는 ready 이후에만
 * 발생함이 보장되므로(Electron 문서) 이 시점에 app.focus/dialog 를 쓰는 것은
 * 항상 안전하다.
 *
 * @param {{ message: string, detail: string }} notice - describeVersionMismatch() 의 결과(matches: false 인 경우)
 * @param {{ action: 'relaunch', execPath: string } | { action: 'quit-notice' }} quitAction - decideQuitAction() 의 결과
 */
function showVersionMismatchDialog ({ message, detail }, quitAction) {
  app.focus({ steal: true })
  const { buttonLabel, callToAction } = describeQuitAction(quitAction)
  dialog.showMessageBox({
    type: 'warning',
    title: 'Keep Sticky 버전이 다릅니다',
    message,
    detail: `${detail}\n\n${callToAction}`,
    buttons: [buttonLabel, '취소'],
    // Enter(defaultId)나 Esc(cancelId)를 무심코 눌렀을 때 실행 중이던 것이
    // 종료되면 안 된다 — 둘 다 안전한 쪽인 [취소](인덱스 1)를 가리킨다.
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }).then((result) => {
    if (result.response !== 0) return // [취소] — 아무 일도 하지 않는다
    // app.relaunch() 는 "종료되면 이 exe 를 다시 띄워라"는 예약일 뿐, 그
    // 자체로는 아무것도 안 죽이지도 새로 띄우지도 않는다(Electron 문서: "이
    // 메서드는 실행 시 앱을 종료하지 않는다 — app.relaunch() 뒤에 app.quit()
    // 이나 app.exit() 을 불러야 실제로 재시작된다"). 그래서 이 예약은 반드시
    // app.quit() 보다 먼저 걸어 둬야 하고, 실제 종료 절차(미저장 편집 flush →
    // 사이드카 정리)는 아래 app.quit() 이 그대로 트리거하는 before-quit 이
    // 맡는다 — relaunch 예약이 그 절차를 건너뛰게 하지 않는다.
    if (quitAction.action === 'relaunch') {
      app.relaunch({ execPath: quitAction.execPath })
    }
    // 트레이 [종료]와 똑같은 경로: app.quit() 뿐이다. before-quit 의
    // flushAllNotes() → stopSidecar() → app.quit() 재진입이 그대로 실행되므로,
    // 지금 열려 있는 포스트잇의 미저장 편집도 이 경로를 거쳐 저장된다.
    app.quit()
  }).catch((err) => {
    // showMessageBox 가 거절되는 경우는 문서화돼 있지 않지만, 혹시라도 거절되면
    // 조용히 삼킨다 — 여기서 예외가 새어나가 앱을 죽이는 것보다 "사용자가 응답
    // 하지 않은 것"과 같은 결과(아무 일도 안 일어남)가 더 안전하다.
    console.warn(`버전 불일치 다이얼로그 처리 중 오류: ${err.message}`)
  })
}

/**
 * Electron 이 기본으로 붙여 주는 메뉴 막대(File / Edit / View / Window / Help)를
 * 없앤다. 이 앱은 그 항목을 하나도 쓰지 않는데, 460×620 짜리 목록 창에서는 그
 * 한 줄이 목록 두 줄만큼을 잡아먹는다.
 *
 * 클립보드 단축키에 대해:
 *
 * Windows(그리고 Linux)에서 편집 가능한 요소 안의 Ctrl+C / Ctrl+V / Ctrl+X /
 * Ctrl+A / Ctrl+Z 는 메뉴가 아니라 Chromium 렌더러가 직접 처리한다. 메뉴의
 * { role: 'copy' } 항목은 그 동작을 메뉴에서도 부를 수 있게 해 주는 것일 뿐이고
 * (Electron 문서의 webContents.copy() 와 같은 편집 명령이다), 그 항목이 없다고
 * 키 입력이 사라지지는 않는다. 그래서 여기서 메뉴를 없애도 포스트잇의 제목
 * 입력칸과 본문 textarea 에서 복사/붙여넣기는 그대로 동작한다.
 *
 * macOS 는 다르다. 그쪽에서는 Cmd+C 같은 키가 NSMenu 의 key equivalent 를 타고
 * 전달되므로, 메뉴를 통째로 없애면 정말로 복사/붙여넣기가 죽는다. 이 앱은 지금
 * Windows 전용(package.json 의 build.win)이지만, 나중에 누가 macOS 로 빌드했을
 * 때 그 함정에 빠지지 않도록 거기서는 편집 역할만 남긴 최소 메뉴를 세운다.
 * appMenu 를 같이 두는 이유: macOS 는 첫 번째 최상위 항목을 앱 메뉴로 쓰므로,
 * 그것이 없으면 Edit 이 앱 메뉴 자리에 끌려 들어가 이름이 이상해진다.
 */
function applyMinimalMenu () {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' }
  ]))
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
    // 자격증명이 무효가 되면 목록 창의 [동기화]도 실패한다. 그 창을 닫아 둔
    // 사용자에게는 여기가 유일한 통로다. 실패해도 트레이를 죽이지 않는다.
    onRelogin: () => { runLoginFlow().catch(() => {}) },
    // 시작할 때의 자동 확인은 조용하다(새 버전이 있을 때만 말한다). 사용자가
    // 직접 물어보는 통로가 따로 있어야 "지금 최신인지" 확인할 수 있다.
    onCheckUpdate: () => { checkForUpdate({ silent: false }).catch(() => {}) },
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
    // 압정의 상태. 이 필드가 생기기 전에는 여기 true 가 박혀 있었고, 그래서
    // 기본값도 true 다(store.js 의 DEFAULT_NOTE_STATE 주석 참고) — 옛 메모가
    // 업데이트 한 번에 뒤로 가라앉지 않는다.
    alwaysOnTop: state.alwaysOnTop !== false,
    skipTaskbar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'note.html'))
  noteWindows.set(noteId, win)

  const persistBounds = () => {
    // 접혀 있는 동안(그리고 막 펼친 직후)의 좌표는 책갈피의 것이지 메모의
    // 것이 아니다. 여기서 적으면 펼칠 자리를 잃는다.
    if (boundsFrozen.has(noteId)) return
    // 휴지통으로 보낸 메모의 항목은 방금 지웠다. 창이 사라지는 동안 늦게 오는
    // moved/resized 하나가 그 항목을 되살리면 안 된다.
    if (trashedNotes.has(noteId)) return
    if (win.isDestroyed()) return
    const b = win.getBounds()
    store.setNote(noteId, { x: b.x, y: b.y, w: b.width, h: b.height })
    store.save()
  }
  win.on('moved', persistBounds)
  win.on('resized', persistBounds)

  // 바탕화면 보기(Win+D)나 [모두 최소화]가 책갈피를 내려도 즉시 되돌린다.
  //
  // 접힌 창에는 최소화 단추가 없다(상단 바 자체가 감춰진다). 그래서 여기 오는
  // 최소화는 사용자가 이 창에 대고 시킨 일이 아니라 셸이 전체에 건 것뿐이다 —
  // 되돌려도 사용자의 뜻을 거스르지 않는다. 펼친 포스트잇은 건드리지 않는다.
  //
  // 맨 앞으로 고정하는 것(foldNote)과 별개로 이 그물이 필요한 이유: 바탕화면
  // 보기가 창을 가리는 경로와 최소화하는 경로가 윈도우 버전·설정에 따라 갈리고,
  // 어느 쪽이든 손잡이가 사라지면 사용자는 메모를 다시 펼칠 수 없다.
  win.on('minimize', () => {
    if (!isFolded(noteId) || win.isDestroyed()) return
    win.restore()
  })

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
  const displays = screen().getAllDisplays()
  // 접은 뒤에 모니터를 뽑았을 수 있다. 그 경우 주 모니터로 데려온다 —
  // 없는 화면에 붙여두면 사용자가 영영 못 찾는다.
  const displayOf = (id) => displays.find((d) => d.id === id) || screen().getPrimaryDisplay()

  // (모니터, 변) 단위로 나눈다. 자리를 한 장씩 정하지 않고 묶음째 정하는 것이
  // 핵심이다 — 그래야 빈틈도 겹침도 생길 수 없다(bookmark-layout.js 참고).
  // 왼쪽으로 옮긴 책갈피가 오른쪽 줄에 빈자리를 남기지 않는 것도 이 덕이다.
  const groups = new Map()
  for (const entry of foldOrder) {
    const win = noteWindows.get(entry.id)
    if (!win || win.isDestroyed()) continue
    const anchor = (store.getNote(entry.id) || {}).bookmark
    const displayId = anchor ? anchor.displayId : entry.displayId
    const side = anchor && anchor.side === 'left' ? 'left' : 'right'
    const key = `${displayId}:${side}`
    if (!groups.has(key)) groups.set(key, { displayId, side, members: [] })
    // y 가 null 이면 "한 번도 안 옮겼다" — 그런 장은 줄 맨 뒤에 접힌 순서대로 선다.
    groups.get(key).members.push({ id: entry.id, y: anchor ? anchor.y : null })
  }

  let dirty = false
  for (const group of groups.values()) {
    const workArea = displayOf(group.displayId).workArea
    for (const placed of packBookmarks(workArea, group.members, group.side, BOOKMARK)) {
      const win = noteWindows.get(placed.id)
      if (!win || win.isDestroyed()) continue
      win.setBounds(placed.bounds)

      // 실제로 놓인 자리를 앵커에도 적어 둔다. 저장된 y 는 "놓고 싶었던 자리"라
      // 쌓고 나면 실제 자리와 몇십 px 씩 어긋나는데, 그대로 두면 다음 드래그의
      // 정렬 기준이 화면에 보이는 것과 달라져 순서가 엉뚱하게 뒤집힌다.
      const state = store.getNote(placed.id)
      if (state && state.bookmark && state.bookmark.y !== placed.bounds.y) {
        store.setNote(placed.id, { bookmark: { ...state.bookmark, y: placed.bounds.y } })
        dirty = true
      }
    }
  }
  if (dirty) store.save()
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

  // **책갈피는 압정 설정과 무관하게 언제나 맨 앞이다.**
  //
  // 펼친 포스트잇의 압정은 "이 메모를 다른 창 위에 띄울까"라는 취향이고 끄고
  // 싶을 이유가 충분하다. 책갈피는 다르다 — 화면 가장자리에 붙은 44px 짜리
  // **손잡이**이고, 가려지면 다시 펼칠 방법 자체가 사라진다. 옵션일 수 없다.
  //
  // state.json 의 alwaysOnTop 은 건드리지 않는다. 펼칠 때 그 값으로 되돌리므로
  // 사용자가 고른 압정 설정은 그대로 남는다.
  //
  // 'screen-saver' 단계인 것은 바탕화면 보기(Win+D) 때문이다. 평범한 topmost 는
  // 바탕화면이 앞으로 나오면 그 뒤로 가려진다 — 실제 앱의 책갈피 창을
  // 들여다보니 TOPMOST 가 꺼져 있어 정확히 그 일이 벌어지고 있었다.
  win.setAlwaysOnTop(true, 'screen-saver')

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
    // 접는 동안 강제로 걸어 둔 맨 앞을 사용자가 고른 압정 설정으로 되돌린다.
    // state.json 의 값은 접는 동안에도 건드리지 않았으므로 그대로 쓴다 —
    // 압정을 꺼 둔 메모는 펼치면 다시 다른 창 뒤로 갈 수 있다.
    win.setAlwaysOnTop(state.alwaysOnTop !== false)
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
 * 로 가는 길은 없고, 있어서도 안 된다. 삭제는 포스트잇의 [삭제] 버튼과 우클릭,
 * 둘 다 확인을 거쳐 notes:trash 하나로 들어가는 그 경로뿐이다.
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

/**
 * 서체 설정이 바뀌었음을 살아 있는 모든 창에 알린다. 다시 띄우지 않고도
 * 반영되게 하는 유일한 통로다. 지금은 목록 창 하나만 듣지만, 포스트잇이 같은
 * onFontSettings 를 붙이면 그대로 같이 따라온다 — 여기에 더 손댈 것이 없다.
 */
function broadcastFontSettings (settings) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) continue
    wc.send('settings:fonts', settings)
  }
}

/**
 * Keep 쪽 노트 집합이 바뀌었음을 목록 창에 알린다. 지금은 휴지통으로 보낸
 * 직후에만 부른다.
 *
 * 목록 창이 떠 있지 않은 경우가 정상이다 — 이 앱은 트레이에서 살고 목록 창은
 * 사용자가 닫아둘 수 있다. 그때는 아무것도 하지 않는 것이 맞다: 다음에 목록
 * 창을 열면 createListWindow 가 list.html 을 새로 띄우고, list.js 는 뜨자마자
 * reload() 로 list_notes 를 다시 받는다. 즉 "열려 있으면 지금 갱신, 닫혀 있으면
 * 다음에 열 때 갱신"이 되고, 어느 쪽이든 지운 메모는 목록에 없다.
 *
 * listWindow 는 창이 실제로 사라질 때 'closed' 에서 null 이 되지만, 그것만
 * 믿지 않고 isDestroyed()/webContents 까지 확인한다 — broadcastFontSettings 와
 * 같은 관례다.
 */
function notifyNotesChanged () {
  if (!listWindow || listWindow.isDestroyed()) return
  const wc = listWindow.webContents
  if (!wc || wc.isDestroyed()) return
  wc.send('notes:changed')
}

/**
 * 포스트잇에서 고른 색을 목록 창의 그 행에도 입힌다. 목록 행의 배경색이 곧 그
 * 메모의 색이므로(list.html), 둘이 동시에 떠 있는데 한쪽만 바뀌면 눈에 띄게
 * 어긋난다.
 *
 * **notes:changed 를 재활용하지 않는 이유**가 이 함수의 존재 이유다. 그 신호는
 * 목록 창을 reload() 시키는데, reload() 는 체크 상태를 실제로 떠 있는 창들로
 * 통째로 다시 맞춘다 — 사용자가 목록에서 체크만 해 두고 아직 [완료] 를 누르지
 * 않았다면 그 체크가 색 한 번 바꿨다고 날아간다. 색만 바뀐 것을 아는 여기서는
 * 색만 보내면 되고, 목록 창은 다시 그리기만 하므로 체크가 그대로 남는다.
 * 사이드카 왕복(list_notes)이 없다는 것도 덤이다.
 */
// --- 자동 업데이트 ----------------------------------------------------------
//
// 포터블 exe 라 electron-updater 를 쓸 수 없다(그것은 NSIS 설치본을 받아 실행
// 한다). 대신 이 앱에 이미 있던 조각들을 이어 붙인다: 원본 exe 경로를 아는
// PORTABLE_EXECUTABLE_FILE, "무엇을 받을지" 정하는 update-check.js, 그리고
// **다른** exe 를 띄우는 app.relaunch({ execPath }) — 버전 불일치 대화상자가
// 쓰던 바로 그 경로다. 여기서 새로 하는 일은 릴리즈 조회와 내려받기뿐이다.

const UPDATE_REPO = 'hanbroz/keep-memo'
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
// 내려받기 제한 시간. 91MB 짜리라 느린 회선도 견뎌야 하지만, 영영 매달려 있으면
// 사용자는 앱이 멈춘 줄 안다.
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000

// 켜 둔 동안에도 다시 확인하는 주기.
//
// **시작할 때 한 번으로는 모자란다.** 이 앱은 트레이에 사는 상주 앱이라 며칠씩
// 켜져 있고, 사용자가 굳이 재시작할 이유가 없다. 그동안 올라온 릴리즈는 시작
// 확인만으로는 영영 보이지 않는다.
//
// 4시간인 이유: 릴리즈는 드물게 올라오고, GitHub 의 비인증 API 한도는 시간당
// 60회라 여유가 크다. 더 자주 볼 이유가 없다.
const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000

// 사용자가 [취소] 를 누른 버전. 주기 확인이 같은 것을 몇 시간마다 다시 묻지
// 않게 한다. 앱을 다시 켜면 잊는다 — 그때는 한 번 더 물어볼 만하다.
let declinedUpdateVersion = null

/** 이 빌드의 "yyyy.MM.dd.HH.mm". 개발 실행에는 없다(그때는 확인하지 않는다). */
function currentBuildStamp () {
  try {
    // 패키징본에서는 app.asar 안의 package.json 이고, electron-builder 가
    // --config.extraMetadata.buildStamp 로 심어 둔 값이 들어 있다.
    return require('../package.json').buildStamp || null
  } catch {
    return null
  }
}

/** GitHub 에서 최신 릴리즈 하나를 받아온다. 실패하면 던진다. */
async function fetchLatestRelease () {
  const res = await fetch(UPDATE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      // GitHub 는 User-Agent 없는 요청을 거절한다.
      'User-Agent': `KeepSticky/${currentBuildStamp() || 'dev'}`
    },
    signal: AbortSignal.timeout(30000)
  })
  if (!res.ok) throw new Error(`릴리즈 정보를 받지 못했습니다 (HTTP ${res.status})`)
  return res.json()
}

/**
 * 새 exe 를 지금 실행 중인 exe **옆에** 내려받는다.
 *
 * 실행 중인 파일을 덮어쓰지 않는 것이 요점이다. 포터블 exe 의 이름에는 이미
 * 버전이 들어 있으므로(KeepSticky-yyyy.MM.dd.HH.mm.exe) 새 이름으로 나란히
 * 받으면 되고, 그러면 윈도우의 파일 잠금과 씨름할 일이 없다. 옛 파일은 남는다 —
 * 지우는 것은 사용자 몫이다. 우리가 지웠다가 되돌릴 방법이 없다.
 *
 * .part 로 받아 다 받은 뒤에 이름을 바꾼다. 중간에 끊긴 파일이 실행 가능한
 * 이름을 갖고 있으면 사용자가 그것을 두 번 클릭한다.
 */
async function downloadUpdate (asset, targetDir) {
  const finalPath = path.join(targetDir, asset.name)
  const partPath = `${finalPath}.part`

  const res = await fetch(asset.url, {
    headers: { 'User-Agent': `KeepSticky/${currentBuildStamp() || 'dev'}` },
    signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`내려받지 못했습니다 (HTTP ${res.status})`)

  const buffer = Buffer.from(await res.arrayBuffer())
  // 크기가 릴리즈가 말한 것과 다르면 받다 만 것이다. 그대로 실행시키면
  // "열리지 않는 exe" 가 되고 원인을 짐작하기 어렵다.
  if (asset.size > 0 && buffer.length !== asset.size) {
    throw new Error(`받은 크기가 다릅니다 (${buffer.length} / ${asset.size} bytes)`)
  }
  fs.writeFileSync(partPath, buffer)
  fs.renameSync(partPath, finalPath)
  return finalPath
}

/**
 * 새 버전이 있는지 보고, 있으면 물어본 뒤 받아서 그것으로 재시작한다.
 *
 * @param {{silent: boolean}} opts silent 면 "최신입니다" 같은 결과를 알리지
 *   않는다. 시작할 때의 자동 확인이 그렇다 — 켤 때마다 대화상자가 뜨면 안 된다.
 *   트레이에서 사용자가 직접 부른 경우는 반대로 반드시 결과를 말해야 한다.
 */
async function checkForUpdate ({ silent }) {
  const stamp = currentBuildStamp()
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE || null

  let decision
  try {
    decision = decideUpdate(stamp, await fetchLatestRelease())
  } catch (err) {
    if (!silent) {
      dialog.showMessageBox({ type: 'info', message: '업데이트를 확인하지 못했습니다.', detail: err.message })
    }
    return
  }

  if (decision.action === 'none') {
    if (!silent) dialog.showMessageBox({ type: 'info', message: decision.reason })
    return
  }
  // 받을 것이 있는데 어디에 둘지 모른다(포터블이 아닌 실행). 조용히 삼키지 않고
  // 직접 받을 수 있게 알려 준다.
  if (!exePath) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'info',
        message: `새 버전 ${decision.version} 이 있습니다.`,
        detail: '이 실행 방식에서는 자동으로 받을 수 없습니다. 릴리즈 페이지에서 직접 받아 주세요.'
      })
    }
    return
  }

  // 자동 확인에서 이미 거절한 버전은 다시 묻지 않는다. 주기적으로 확인하므로
  // 이 기억이 없으면 [취소] 를 누른 사용자에게 같은 것을 몇 시간마다 다시 묻게
  // 된다 — 그건 알림이 아니라 잔소리다. 트레이에서 직접 물어보는 경우(silent
  // 아님)는 사용자가 방금 요청한 것이므로 이 기억을 무시한다.
  if (silent && decision.version === declinedUpdateVersion) return

  const ask = await dialog.showMessageBox({
    type: 'question',
    buttons: ['확인', '취소'],
    defaultId: 0,
    cancelId: 1,
    message: `새로운 업데이트 ver. ${decision.version} 가 있습니다. 업데이트 하시겠습니까?`,
    detail: `지금 버전: ${stamp}\n받을 파일: ${decision.name}\n\n` +
            '받는 동안 잠시 걸립니다. 다 받으면 지금 창들을 정리하고 새 버전으로 다시 시작합니다.'
  })
  if (ask.response !== 0) {
    declinedUpdateVersion = decision.version
    return
  }

  let downloaded
  try {
    downloaded = await downloadUpdate(decision, path.dirname(exePath))
  } catch (err) {
    dialog.showMessageBox({ type: 'error', message: '업데이트를 받지 못했습니다.', detail: err.message })
    return
  }

  // 여기서부터는 버전 불일치 대화상자가 쓰던 경로 그대로다. relaunch 예약을
  // app.quit() **보다 먼저** 걸어야 하고, 실제 종료 절차(미저장 편집 flush →
  // 사이드카 정리)는 app.quit() 이 트리거하는 before-quit 이 맡는다.
  app.relaunch({ execPath: downloaded })
  app.quit()
}

/**
 * 주소를 검증하고 기본 브라우저로 넘긴다. 밖으로 나가는 **모든** 주소가 이
 * 한 곳을 지난다 — 포스트잇 본문의 Ctrl+클릭도, 목록 창의 [Keep 열기] 도.
 *
 * **여기가 진짜 검증 지점이다.** 렌더러도 같은 sanitizeUrl 을 부르지만 그것은
 * 사용자에게 즉시 안내를 띄우기 위한 것이고, 렌더러는 신뢰 경계의 바깥쪽이다 —
 * 그쪽에만 있는 검사는 검사가 아니다. shell.openExternal() 은 받은 문자열을
 * 그대로 운영체제에 넘기고, 그 문자열은 Keep 에서 온 외부 데이터라 무엇이든
 * 들어 있을 수 있다. http/https 가 아니면 어떤 것도 여기를 통과하지 못한다.
 *
 * 넘기는 값은 부르는 쪽이 준 원문이 아니라 sanitizeUrl 이 돌려준 parsed.href 다 —
 * 파서가 정규화하고 퍼센트 인코딩까지 마친 값이다.
 */
async function openChecked (raw) {
  const checked = sanitizeUrl(raw)
  if (!checked.ok) return { ok: false, code: checked.reason }
  try {
    await shell.openExternal(checked.url)
    return { ok: true }
  } catch (err) {
    return { ok: false, code: 'OPEN_FAILED', message: err.message }
  }
}

function notifyNoteColor (id, color) {
  if (!listWindow || listWindow.isDestroyed()) return
  const wc = listWindow.webContents
  if (!wc || wc.isDestroyed()) return
  wc.send('notes:color', id, color)
}

app.whenReady().then(async () => {
  // 기본 메뉴 제거는 창을 하나라도 만들기 전에 한다 — 최초 실행 설정 창과 로그인
  // 창까지 포함해서다. 창이 생긴 뒤에 부르면 그 창들은 메뉴를 단 채로 뜬다.
  applyMinimalMenu()

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
    stopSidecar('이메일 미설정')
    app.quit()
    return
  }

  startSidecar()

  ipcMain.handle('notes:list', () => sidecar.call('list_notes'))

  // --- 라벨 -----------------------------------------------------------------
  //
  // 라벨은 노트의 필드가 아니라 계정에 따로 사는 개체라(다대다) 자기 RPC 를
  // 갖는다. 다섯이 전부 같은 모양이므로 shape 를 만드는 일도 한 곳에 둔다 —
  // 사이드카가 던지는 오류를 { ok:false, code } 로 바꿔야 렌더러가 AUTH_REQUIRED
  // 를 다른 실패와 구별해 재로그인으로 이어갈 수 있다(notes:update 와 같은 관례).
  const labelCall = async (method, params) => {
    try {
      return { ok: true, ...(await sidecar.call(method, params)) }
    } catch (err) {
      return { ok: false, message: err.message, code: err.code }
    }
  }

  ipcMain.handle('labels:list', () => labelCall('list_labels'))
  ipcMain.handle('labels:create', (_e, name) => labelCall('create_label', { name }))
  ipcMain.handle('labels:rename', (_e, id, name) => labelCall('rename_label', { id, name }))
  ipcMain.handle('labels:delete', (_e, id) => labelCall('delete_label', { id }))
  ipcMain.handle('labels:setForNote', async (_e, id, labelIds) => {
    const res = await labelCall('set_note_labels', { id, label_ids: labelIds })
    // 라벨이 바뀌면 목록 창의 행 표시와 필터가 달라진다. 순서는 그대로지만
    // 어느 행에 무엇이 붙었는지가 바뀌므로 다시 읽어야 한다.
    if (res.ok) notifyNotesChanged()
    return res
  })

  // 목록 창의 [동기화]. list_notes 는 이 세션이 맨 처음 authenticate() 했을
  // 때의 상태를 그대로 보여줄 뿐이라, 다른 기기(폰이나 keep.google.com)에서
  // 생긴 변경 — 특히 삭제 — 가 이 세션에는 영영 안 보이는 문제가 있었다.
  // 사이드카의 sync_notes 는 keep.sync() 를 먼저 부른 뒤 목록을 만든다
  // (keep_service.py 의 sync_notes 주석에 실계정으로 확인한 근거가 있다).
  //
  // 실패(네트워크, 만료된 세션, 죽은 사이드카)는 던지지 않고 { ok:false }
  // shape 로 돌려준다 — auth:exchange 와 같은 관례다. ipcMain.handle 이
  // 던지면 렌더러에는 message 만 건너가고 err.code 는 사라지므로, 코드를
  // 보존해 렌더러가 AUTH_REQUIRED 를 다른 실패와 구별해 보여줄 수 있게 한다.
  ipcMain.handle('notes:sync', async () => {
    let result
    try {
      result = await sidecar.call('sync_notes')
    } catch (err) {
      return { ok: false, message: err.message, code: err.code }
    }
    const notes = Array.isArray(result && result.notes) ? result.notes : []

    // Keep 에서 사라진(다른 기기가 지웠거나 트래시로 보낸) 메모의 포스트잇이
    // 아직 바탕화면에 떠 있을 수 있다. 그대로 두면 다음 저장이 사이드카에서
    // NOT_FOUND 로 떨어진다 — 사용자에게는 "저장이 계속 실패하는 멀쩡해 보이는
    // 창"으로만 보인다. 여기서 미리 바탕화면에서 내린다. trash_note 는 부르지
    // 않는다 — Keep 에는 이미 없는 메모라 다시 지우라고 할 대상이 없다.
    const orphans = orphanedNoteIds(desktopIds(), notes)
    for (const id of orphans) {
      trashedNotes.add(id)
      hideNote(id)
      store.forgetNote(id)
    }
    if (orphans.length > 0) store.save()

    return { ok: true, notes }
  })

  ipcMain.handle('notes:create', async (_e, title, text) => {
    const res = await sidecar.call('create_note', { title, text })
    return res.note
  })

  // 만들기 핸들러는 위 하나뿐이다. 이 앱이 만드는 메모는 언제나 text 노트다 —
  // 체크리스트는 메모의 종류가 아니라 본문 안의 텍스트 규약이기 때문이다
  // (app/renderer/line-model.js). 예전에 있던 notes:createChecklist 와 사이드카의
  // create_checklist 는 그래서 없앴다.
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

  // 목록 창의 [완료] 가 반영을 끝낸 뒤 마지막으로 부른다.
  //
  // 닫을 창을 listWindow 전역이 아니라 보낸 쪽(sender)에서 찾고, 그것이 정말
  // 목록 창일 때만 닫는다. 이렇게 하면 이 핸들러가 listWindow 추적과 싸울 일이
  // 없다 — 참조를 여기서 비우지 않고, 창이 실제로 사라질 때 createListWindow 가
  // 걸어 둔 'closed' 가 (동일성까지 확인하고) 비운다. 포스트잇이 이 경로로
  // 닫히는 것도 막는다: 포스트잇은 notes:close 를 거쳐야 state.json 에
  // visible: false 로 남는다.
  ipcMain.handle('list:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== listWindow || win.isDestroyed()) return { ok: false }
    win.close()
    return { ok: true }
  })

  // 서체 설정. 검증과 기본값은 전부 store(=font-settings.js)가 한다.
  ipcMain.handle('settings:getFonts', () => store.getFontSettings())
  ipcMain.handle('settings:setFonts', (_e, raw) => {
    const saved = store.setFontSettings(raw)
    store.save()
    broadcastFontSettings(saved)
    return saved
  })

  ipcMain.handle('notes:fold', (_e, id) => ({ ok: foldNote(id) }))
  ipcMain.handle('notes:unfold', (_e, id) => ({ ok: unfoldNote(id) }))

  // 압정. 저장은 언제나 main 이 하고 실제로 저장된 값을 돌려준다 —
  // notes:setFont 와 같은 관례다. 렌더러는 자기가 보낸 값이 아니라 돌아온
  // 값으로 단추를 그린다.
  ipcMain.handle('notes:getAlwaysOnTop', (_e, id) => (store.getNote(id) || {}).alwaysOnTop !== false)
  ipcMain.handle('notes:setAlwaysOnTop', (_e, id, on) => {
    const next = !!on
    const saved = store.setNote(id, { alwaysOnTop: next })
    store.save()
    const win = noteWindows.get(id)
    // 창이 이미 사라진 뒤에 늦게 도착한 요청이어도 state.json 에는 남는다 —
    // 다음에 그 메모를 띄울 때 createNoteWindow 가 이 값을 읽는다.
    //
    // **접혀 있으면 창에는 적용하지 않는다.** 책갈피는 압정과 무관하게 언제나
    // 맨 앞이어야 하는데(foldNote 참고), 여기서 창에 그대로 걸면 그 강제를
    // 덮어 손잡이가 가려진다. 설정은 저장해 두었다가 unfoldNote 가 펼칠 때
    // 적용한다.
    if (win && !win.isDestroyed() && !isFolded(id)) win.setAlwaysOnTop(next)
    return saved.alwaysOnTop !== false
  })

  // --- 책갈피 끌어 옮기기 ---------------------------------------------------
  //
  // 렌더러가 창의 왼쪽 위가 가야 할 화면 좌표를 그대로 보낸다. 잡은 지점이
  // 창 안 어디였는지는 렌더러가 알고 있으므로(pointerdown 의 clientX/Y),
  // main 이 그 오프셋을 따로 들고 있을 이유가 없다 — 끌기 상태를 main 에
  // 두면 렌더러가 죽거나 창이 닫힐 때 그 상태를 정리할 길을 또 만들어야 한다.
  //
  // 끄는 동안에는 저장하지 않는다. 화면만 따라 움직이고, 놓는 순간(drop)에
  // 한 번만 가장자리에 붙이고 state.json 에 적는다.
  ipcMain.handle('notes:bookmarkMove', (_e, id, x, y) => {
    const win = noteWindows.get(id)
    // 접혀 있을 때만 옮긴다. 펼친 메모는 창 자체를 끄는 것이지 이 경로가 아니다.
    if (!win || win.isDestroyed() || !isFolded(id)) return { ok: false }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false }
    const b = win.getBounds()
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height })
    return { ok: true }
  })

  ipcMain.handle('notes:bookmarkDrop', (_e, id, x, y) => {
    const win = noteWindows.get(id)
    if (!win || win.isDestroyed() || !isFolded(id)) return { ok: false }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false }

    // 놓은 자리가 어느 모니터인가. getDisplayMatching 은 겹치는 넓이가 가장
    // 큰 모니터를 주므로, 두 화면에 걸쳐 놓아도 더 많이 걸친 쪽으로 간다.
    const dropped = { x: Math.round(x), y: Math.round(y), width: BOOKMARK.width, height: BOOKMARK.height }
    const display = screen().getDisplayMatching(dropped)
    const anchor = bookmarkAnchorFromDrop(display.workArea, dropped, BOOKMARK)
    const saved = { displayId: display.id, side: anchor.side, y: anchor.y }

    store.setNote(id, { bookmark: saved })
    store.save()
    // 앵커는 펼쳤다 다시 접어도 남는다. 지웠다면 "✕ 를 가리지 않게" 옮겨 둔
    // 자리가 접을 때마다 원래의 오른쪽 위로 돌아가, 같은 드래그를 매번 다시
    // 해야 한다 — 고치려던 문제로 그대로 돌아가는 셈이다. 다음 드래그가
    // 덮어쓸 뿐이다.
    //
    // 접힌 순서 목록의 모니터도 같이 맞춰 둔다. 두 곳이 이 책갈피가 어느
    // 모니터에 있는지를 서로 다르게 알고 있으면 안 된다 — 자동 배치로 돌아갈
    // 일이 생겼을 때 엉뚱한 화면에서 줄을 서게 된다.
    const entry = foldOrder.find((e) => e.id === id)
    if (entry) entry.displayId = display.id

    // 자리를 여기서 정하지 않는다. 이 한 장만 놓으면 같은 변의 나머지와
    // 겹치거나 사이가 벌어진다 — 묶음 전체를 다시 쌓아야 빈틈이 없다.
    relayoutBookmarks()
    return { ok: true }
  })

  ipcMain.handle('notes:update', async (_e, id, patch) => {
    // 예전에는 여기서 { id, text: patch.text } 만 만들어 보냈다 — preload 는
    // updateNote(id, patch) 로 임의의 필드를 받는다고 광고하고 사이드카는
    // title 을(그리고 이제 color 도) 받는데, 여기서 text 말고는 전부 조용히
    // 버려졌다. patch 를 통째로 신뢰해 그대로 흘리는 대신, 지원하는 필드만
    // 화이트리스트로 골라 보낸다 — 모르는 필드가 섞여 있으면 일부만 저장하고
    // 나머지를 조용히 버리는 대신 통째로 거절한다.
    const validated = validateNotePatch(patch)
    if (!validated.ok) {
      return { ok: false, message: validated.message, code: 'BAD_REQUEST' }
    }
    // 이미 휴지통으로 보낸 메모에는 아무것도 쓰지 않는다. 여기서 그냥 돌아가는
    // 것이 핵심이다 — 아래 catch 로 떨어지면 store.setNote() 가 conflictBackup 을
    // 다시 만들면서 방금 지운 메모의 항목을 state.json 에 되살린다.
    if (trashedNotes.has(id)) {
      return { ok: false, message: '휴지통으로 보낸 메모입니다.', code: 'NOTE_TRASHED' }
    }
    // color 전용 patch(title 도 text 도 없음)에서는 보관할 미저장 "제목/본문"이
    // 애초에 없다 — selectColor() 는 편집기 내용을 건드리지 않는다. 그
    // 경우에만 conflictBackup 을 null 로 정규화한다(DEFAULT_NOTE_STATE.
    // conflictBackup 도 null 이 "보관본 없음"의 표현이다). title 이나 text 가
    // 하나라도 있으면 렌더러가 보낸 두 필드를 { title, text } 그대로 보관한다 —
    // 포스트잇은 제목 입력칸과 본문이 각자 title/text 를 담당하므로 하나로
    // 합쳤다가 나중에 다시 나눌 이유가 없다. 예전에는 여기서 joinTitleAndText 로
    // 한 문자열을 만들었는데, 그건 편집기가 한 칸짜리 textarea 하나였을 때
    // (첫 줄이 제목 역할) 그 한 문자열을 복원하기 위한 것이었다.
    //
    // **본문이 줄 편집기가 된 뒤에도 이 모양 그대로다.** 체크박스는 본문 텍스트
    // 안의 "- [ ] " / "- [x] " 표식으로 실려 오므로(line-model.js), text 한
    // 필드가 체크 상태까지 남김없이 담는다 — 보관본에 따로 더할 것이 없다.
    const hasTextEdit = validated.params.title !== undefined || validated.params.text !== undefined
    const sentContent = hasTextEdit
      ? { title: validated.params.title, text: validated.params.text }
      : null
    try {
      const res = await sidecar.call('update_note', { id, ...validated.params })
      // 성공한 저장은 앞선 실패/충돌의 보관본을 무효로 만든다. 지우지 않으면
      // 노트 본문이 %APPDATA% 의 state.json 에 무기한 남는데, 이걸 보거나
      // 지우는 UI 는 Phase 2 라서 사용자는 존재조차 모른다.
      store.setNote(id, { conflictBackup: res.conflict ? sentContent : null })
      store.save()
      // 색이 실린 patch 일 때만 목록 창에 알린다. 제목/본문 저장은 훨씬 잦고
      // (포커스가 빠질 때마다) 목록 행의 배경색과는 무관하다. 보내는 값은
      // 우리가 보낸 이름이 아니라 사이드카가 확인해 준 res.note.color 다 —
      // 포스트잇도 같은 값을 입히므로(note.js) 두 창이 어긋날 수 없다.
      if (validated.params.color !== undefined && res.note) {
        notifyNoteColor(id, res.note.color)
      }
      // **보관해도 포스트잇은 내리지 않는다.** 한때 여기서 hideNote(id) 를
      // 불렀는데(보관 = 치워 두기라고 읽었다), 사용자가 [보관] 을 누르는 순간
      // 보고 있던 메모가 눈앞에서 닫혀 버렸다. 되돌리기처럼 보이는 데다,
      // 방금 무엇을 눌렀는지 확인할 화면조차 사라진다.
      //
      // 애초에 이 앱의 상태 두 가지는 서로 독립이다: visible 은 "이 PC 의
      // 바탕화면에 떠 있는가"(state.json), archived 는 "Keep 에서 치워 뒀는가"
      // (Keep 노트의 필드). 색이나 압정을 바꿔도 창이 닫히지 않는 것과 같은
      // 이유로, 보관도 창을 건드릴 이유가 없다. 내리고 싶으면 ✕ 가 있다.
      //
      // 목록 창은 다시 읽어야 한다 — 보관과 고정은 그 메모를 다른 묶음으로
      // 옮기므로(_serialize_for_list 의 고정 → 보관 → 나머지), 색과 달리 행
      // 하나만 고쳐서는 맞출 수 없다. 순서가 통째로 달라진다.
      if (validated.params.archived !== undefined ||
          validated.params.pinned !== undefined) notifyNotesChanged()
      return { ok: true, ...res }
    } catch (err) {
      // ipcMain.handle 이 던지면 렌더러에는 message 만 건너간다 (err.code 는
      // 사라진다). 그러면 재로그인 필요 여부를 렌더러가 알 수 없다. 그래서
      // 여기서 잡아 shape 로 돌려준다 — auth:exchange 와 같은 관례다.
      // 저장 자체가 실패했으므로 이 편집은 서버에 도달하지 못했다. 충돌과
      // 같은 방식으로 conflictBackup 에 보관해 ✕ 를 눌러도 사라지지 않게 한다.
      store.setNote(id, { conflictBackup: sentContent })
      store.save()
      return { ok: false, message: err.message, code: err.code }
    }
  })

  // 폰에서 만든 **진짜 Keep List** 노트의 저장. notes:update 와 같은 뼈대다 —
  // 화이트리스트 검증, 휴지통 가드, conflictBackup 보관, 오류를 던지지 않고
  // shape 로 돌려주기까지 같다. 이 앱은 List 를 새로 만들지 않지만(체크리스트는
  // 본문 텍스트 규약이다), 이미 계정에 있는 List 는 열려서 쓸 수 있어야 하고
  // List.text 는 읽기 전용이라 텍스트로 쓸 수가 없어 통로가 따로 필요하다.
  //
  // **conflictBackup 에 무엇을 담는가**가 이 핸들러의 핵심 결정이다. text 노트는
  // { title, text } 를 담는다 — 체크박스까지 표식으로 그 text 안에 들어 있다.
  // 진짜 List 노트에는 본문 필드가 없고 대신 항목들이 있으므로 { title, items }
  // 를 담는다. 같은 원칙(화면에 있던 것을 그대로, 잃지 않게)을 그 노트의 실제
  // 모양에 맞춘 것이다. items 에는 항목마다 id/text/checked 가 다 들어 있어서,
  // 나중에 이 보관본을 사람이 읽어도 무엇이 저장되지 못했는지 알 수 있다.
  //
  // color 전용 patch 같은 것이 없으므로(색은 여전히 notes:update 로 간다)
  // 여기서는 sentContent 가 null 이 되는 경우가 없다 — 항상 보관할 것이 있다.
  ipcMain.handle('notes:updateChecklist', async (_e, id, patch) => {
    const validated = validateChecklistPatch(patch)
    if (!validated.ok) {
      return { ok: false, message: validated.message, code: 'BAD_REQUEST' }
    }
    if (trashedNotes.has(id)) {
      return { ok: false, message: '휴지통으로 보낸 메모입니다.', code: 'NOTE_TRASHED' }
    }
    const sentContent = { title: validated.params.title, items: validated.params.items }
    try {
      const res = await sidecar.call('update_checklist', { id, ...validated.params })
      store.setNote(id, { conflictBackup: res.conflict ? sentContent : null })
      store.save()
      return { ok: true, ...res }
    } catch (err) {
      store.setNote(id, { conflictBackup: sentContent })
      store.save()
      return { ok: false, message: err.message, code: err.code }
    }
  })

  // 본문의 URL 을 기본 브라우저로 연다 (포스트잇에서 Ctrl+클릭). 검증과 실제
  // 열기는 openChecked 한 곳에 있다 — 왜 그것이 진짜 경계인지도 그 함수의 주석에.
  ipcMain.handle('shell:openExternal', (_e, raw) => openChecked(raw))

  // 목록 창의 [Keep 열기]. 주소를 렌더러가 아니라 **여기서** 만드는 것이 요점이다:
  // 계정 이메일이 필요한데, 그것 하나 때문에 렌더러에 계정을 넘기고 싶지 않다
  // (preload 의 표면은 좁을수록 좋다). 렌더러는 "Keep 을 열어 달라"고만 말한다.
  //
  // 만든 주소도 예외 없이 openChecked 를 지난다. 우리가 만든 문자열이라고
  // 검증을 건너뛰기 시작하면, 다음 사람이 그 자리에 변수를 넣는다.
  ipcMain.handle('keep:open', () => openChecked(keepListUrl(accountEmail)))

  // 재로그인. 저장된 master token 이 구글에서 무효가 되면(비밀번호 변경, 기기
  // 접근 해지 등) 이 앱은 스스로 빠져나올 길이 없었다 — auth_status 가 토큰의
  // **존재**만 보므로 재시작해도 로그인 창이 뜨지 않고, 렌더러들은 '재로그인
  // 필요'라고 말만 할 뿐 실제로 다시 로그인시키는 통로가 최초 실행 경로 하나
  // 뿐이었다. 그 통로를 런타임에도 연다.
  //
  // 새 토큰은 exchange_cookie 가 keyring 에 덮어쓰고 사이드카의 _keep 을 비우므로,
  // 다음 호출부터 새 자격증명으로 다시 인증된다. 여기서 따로 지울 것이 없다.
  ipcMain.handle('auth:relogin', async () => {
    try {
      const ok = await runLoginFlow()
      return ok
        ? { ok: true }
        : { ok: false, message: '로그인을 마치지 못했습니다. 창을 닫았거나 시간이 지났습니다.' }
    } catch (err) {
      return { ok: false, message: err.message, code: err.code }
    }
  })

  // 지우기의 유일한 경로. 사이드카의 trash_note 는 node.trash() 를 부른다 —
  // Keep 휴지통으로 보내는 것이고 7일간 복구할 수 있다. node.delete()(영구
  // 삭제)로 가는 길은 이 앱 어디에도 없다.
  //
  // 렌더러의 [삭제] 버튼과 우클릭이 둘 다 이 핸들러 하나를 부른다. ✕(notes:close)
  // 와 목록 창의 체크 해제(notes:applySelection)는 hideNote 만 부르고 여기 오지
  // 않는다 — 그쪽은 바탕화면에서 내리기일 뿐이다.
  ipcMain.handle('notes:trash', async (_e, id) => {
    try {
      await sidecar.call('trash_note', { id })
    } catch (err) {
      // 실패하면 아무것도 건드리지 않는다. 창도 그대로 남는다.
      return { ok: false, message: err.message, code: err.code }
    }
    // 창을 닫기 **전에** 표시한다. hideNote() 안의 win.close() 가 렌더러에
    // 마지막 flush 를 요청하고, 그 응답으로 오는 notes:update 는 위 가드에
    // 걸려야 한다.
    trashedNotes.add(id)
    hideNote(id)
    // 지운 메모의 위치/크기/서체/보관본을 state.json 에서 통째로 지운다.
    // hideNote() 가 방금 visible: false 로 항목을 남겨두고 갔으므로 반드시
    // 그 뒤여야 한다.
    store.forgetNote(id)
    store.save()
    // 목록 창이 떠 있으면 지금 갱신한다. 떠 있지 않으면 할 일이 없다 —
    // 이유는 notifyNotesChanged 주석에 있다.
    notifyNotesChanged()
    return { ok: true }
  })

  // 노트별 서체 재정의. Keep 에 서체 필드가 없어 이 값은 state.json 에만 있다.
  // 검증과 기본값은 전부 store(=note-font.js)가 한다 — 여기서는 저장하고 실제로
  // 저장된 값을 돌려줄 뿐이다(settings:setFonts 와 같은 관례다).
  ipcMain.handle('notes:getFont', (_e, id) => store.getNoteFont(id))
  ipcMain.handle('notes:setFont', (_e, id, raw) => {
    const saved = store.setNoteFont(id, raw)
    store.save()
    return saved
  })

  if (!(await ensureAuth())) {
    // 이 시점에 남아 있는 창이 없다(로그인 창은 ensureAuth 안에서 닫힌다).
    // 그리고 트레이가 살아 있으므로 window-all-closed 는 앱을 끝내지 않는다.
    // 즉 여기서 조용히 return 하면 사이드카(와 마스터 토큰을 쥔 Python 자식
    // 프로세스)가 안 죽고 남아, 사용자가 작업 관리자로 끌 수밖에 없는 유령
    // 프로세스가 된다. 아이콘만 남고 뒤에 아무것도 없는 트레이는 그보다 더
    // 나쁘다. 실패를 반환한 쪽이 종료까지 책임진다.
    dialog.showErrorBox('Keep 연결 실패', '인증에 실패했습니다. 앱을 종료합니다.')
    stopSidecar('인증 실패')
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

  // 시작하고 나서 조용히 한 번 확인한다. 목록 창이 뜬 **뒤**라 앱을 켜는 속도를
  // 늦추지 않고, 새 버전이 없으면 아무 말도 하지 않는다. 실패(네트워크 없음 등)도
  // 삼킨다 — 업데이트 확인 때문에 앱을 못 쓰게 되면 안 된다.
  checkForUpdate({ silent: true }).catch(() => {})

  // 그 뒤로는 주기적으로 다시 본다. 켜 둔 동안 올라온 릴리즈도 잡아야 한다.
  // unref() 로 이 타이머가 앱의 수명을 붙잡지 않게 한다 — 종료를 늦추면 안 된다.
  setInterval(() => { checkForUpdate({ silent: true }).catch(() => {}) },
    UPDATE_INTERVAL_MS).unref()
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
  stopSidecar('window-all-closed (트레이 없음)')
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
      stopSidecar('before-quit')
    } finally {
      app.quit()
    }
  })
})

// 위 경로를 타지 않은 종료(외부 요인, 재진입 등)에서도 반드시 정리한다.
// 사이드카 정리가 먼저다 — 트레이 아이콘 하나 때문에 파이썬 자식이 남는 일은
// 없어야 한다.
app.on('will-quit', () => {
  stopSidecar('will-quit')
  // Windows 는 프로세스가 사라진 뒤에도 알림 영역에 죽은 아이콘을 남겨두는 일이
  // 있다(마우스를 올려야 그제야 사라진다). 종료했는데 아이콘이 남아 있으면
  // 사용자는 앱이 아직 살아 있다고 읽는다. 명시적으로 지운다.
  if (trayAlive()) tray.destroy()
  tray = null
})

// Windows 종료/로그오프에서는 before-quit / will-quit 이 오지 않는다.
// 저장을 기다릴 시간도 없는 경로다. 최소한 유령 프로세스는 남기지 않는다.
app.on('session-end', () => stopSidecar('session-end (윈도우 로그오프/종료)'))

module.exports = { noteWindows }
