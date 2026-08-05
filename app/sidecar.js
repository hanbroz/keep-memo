'use strict'
const { spawn } = require('node:child_process')
const readline = require('node:readline')

// 사이드카가 죽었을 때 보여줄 stderr 마지막 줄 수. 패키징본은 console=False
// 라 이 링버퍼 말고는 파이썬 쪽 실패를 볼 수 있는 경로가 없다.
const STDERR_TAIL_LINES = 20

// 이만큼 살아 있었으면 "제대로 떴다"고 본다. 그 뒤에 죽는 것은 연쇄 실패가
// 아니라 별개의 사고이므로 재시작 예산을 되돌려 준다.
const HEALTHY_UPTIME_MS = 30000

// 예산을 다 쓴 뒤, 다음 요청이 되살리기를 시도하기까지 기다리는 시간. 진짜로
// 고장 났을 때 요청마다 프로세스를 새로 띄우며 시스템을 두드리지 않게 한다.
const REVIVE_COOLDOWN_MS = 5000

// 정지된 뒤 이만큼 지나도 앱이 살아 요청을 보내면, 그 종료는 일어나지 않은
// 것으로 보고 되살린다. 진짜 종료는 이보다 훨씬 빨리 프로세스를 끝낸다 —
// before-quit 의 미저장 편집 flush 조차 창당 몇 초가 상한이다.
const STALE_STOP_MS = 20000

/**
 * Python 사이드카와 줄 단위 JSON-RPC 로 대화한다.
 * 이 클래스는 배관만 안다. Keep 도메인(노트, 라벨, 색상)은 모른다.
 */
class Sidecar {
  constructor (command, args = [], {
    timeoutMs = 30000,
    maxRestarts = 3,
    onDead = null,
    onRestart = null,
    stderrTailLines = STDERR_TAIL_LINES,
    healthyUptimeMs = HEALTHY_UPTIME_MS,
    reviveCooldownMs = REVIVE_COOLDOWN_MS,
    staleStopMs = STALE_STOP_MS
  } = {}) {
    this.command = command
    this.args = args
    this.timeoutMs = timeoutMs
    this.maxRestarts = maxRestarts
    // maxRestarts 는 **연달아 빠르게** 죽는 것(crash loop)의 한도다. 이만큼
    // 살아 있다 죽은 것은 그 연쇄에 넣지 않는다 — 예전에는 앱 수명 전체를
    // 통틀어 3회였고, 그래서 몇 시간에 걸쳐 어쩌다 세 번 죽은 앱이 그 뒤로
    // 영영 되살아나지 못했다.
    this.healthyUptimeMs = healthyUptimeMs
    this.reviveCooldownMs = reviveCooldownMs
    this.staleStopMs = staleStopMs
    this.startedAt = 0
    this.lastReviveAt = 0
    this.onDead = onDead
    // 재시작된 프로세스는 백지 상태다(set_account 이전). 감독자가 세션 상태를
    // 다시 세울 기회를 여기서 준다 — 이게 없으면 "재시작 = 영구 고장"이 된다.
    this.onRestart = onRestart
    this.stderrTailLines = stderrTailLines
    this.stderrTail = []
    // 마지막으로 사이드카를 쓸 수 없었던 이유. 오류 문구에 그대로 실린다.
    this.unusableReason = '아직 시작하지 않았다'
    this.restarts = 0
    this.stopped = false
    this.stopReason = null
    this.stoppedAt = 0
    this.pending = new Map()
    this.nextId = 1
    this.proc = null
  }

  start () {
    this.startedAt = Date.now()
    const proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // keep_service.py 는 진입점에서 stdin/stdout 을 UTF-8 로 reconfigure
      // 하지만, 그 줄이 실행되기 전(예: import 단계에서 터지는 트레이스백)에는
      // 여전히 OS 로캘 코드페이지 — 한국어 Windows 에서는 cp949 — 를 쓴다.
      // 그 창을 없애려면 프로세스 자체를 UTF-8 로 띄워야 한다. 이게 없으면
      // 가장 필요한 순간(초기화 실패 메시지)에 정작 그 메시지가 또 깨진다.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    })
    this.proc = proc
    readline.createInterface({ input: proc.stdout })
      .on('line', (line) => { if (this.proc === proc) this._onLine(line) })
    // stderr 는 반드시 비워야 한다. 읽지 않으면 파이프 버퍼(Windows 약 64KB)가
    // 차는 순간 자식이 write 에서 영구히 멈춘다 — 죽지 않으니 재시작도 안 걸리고
    // 모든 호출이 타임아웃만 낸다. 여기 담기는 것은 Python 이 stderr 로 뱉은
    // 것뿐이다. RPC 요청/응답 본문은 절대 담지 않는다 — 그쪽에는 계정 전체
    // 권한을 가진 master token 이 지나간다.
    readline.createInterface({ input: proc.stderr })
      .on('line', (line) => { if (this.proc === proc) this._onStderr(line) })
    // 죽은 파이프에 쓰면 스트림이 'error' 를 낸다. 리스너가 없으면 그게 그대로
    // Electron 메인 프로세스의 uncaughtException 이 되어 앱 전체가 사라진다 —
    // 열려 있던 포스트잇과 미저장 편집을 전부 데리고. 실제 실패 처리는 'exit'
    // 와 call() 의 가드가 하므로 여기서는 삼키기만 한다.
    proc.stdin.on('error', () => {})
    // **어느 프로세스의 죽음인지 따진다.** 죽인 프로세스의 'exit' 는 우리가 이미
    // 다음 프로세스를 띄운 **뒤에** 도착할 수 있다. 그때 이 핸들러가 그냥 돌면
    // (가) 방금 보낸 요청을 SIDECAR_DEAD 로 죽이고 (나) 또 한 번 재시작해
    // 살아 있는 자식을 유령으로 흘린다. 실제로 그렇게 프로세스가 샜다.
    proc.on('exit', (code) => this._onExit(proc, `사이드카 종료: ${code}`))
    proc.on('error', (err) => this._onExit(proc, err.message))
    return this
  }

  _onExit (proc, message) {
    if (this.proc !== proc) return // 이미 갈아탄 옛 프로세스의 부고다
    this._rejectAll('SIDECAR_DEAD', message)
    if (this.stopped) return

    // 한참 잘 돌다가 죽은 것은 연쇄 실패가 아니다. 예산을 되돌려 준다.
    // 이 한 줄이 maxRestarts 를 "앱 수명 동안 3번"에서 "연달아 3번"으로 바꾼다.
    if (Date.now() - this.startedAt >= this.healthyUptimeMs) this.restarts = 0

    if (this.restarts >= this.maxRestarts) {
      // 연달아 즉시 죽는다면 지금 다시 띄워봐야 같은 결과다. 여기서는 멈추고
      // 사용자에게 알린다 — 다만 **영구히 포기하지는 않는다**. 다음 요청이
      // 오면 call() 이 쿨다운을 보고 되살리기를 한 번 시도한다. 원인이
      // 일시적이었다면(예: 시스템 자원이 말라 프로세스를 못 띄우던 순간)
      // 그때 되살아난다. 예전에는 여기서 그냥 돌아가 앱이 재시작 전까지
      // 영영 죽은 상태로 남았다.
      if (this.onDead) this.onDead(this._withStderrTail(message))
      return
    }
    this.restarts++
    this.start()
    this._notifyRestart()
  }

  /**
   * 재시작 뒤 감독자에게 세션을 다시 세울 기회를 준다.
   *
   * 프로세스는 살아났지만 세션 상태는 백지다(set_account 이전). 감독자가
   * 그것을 다시 보내지 못하면 이후 모든 호출이 AUTH_REQUIRED 로 떨어진다.
   * 실패해도 여기서 할 수 있는 일은 없으므로 삼킨다 — 다음 실제 호출이
   * 사용자에게 알린다.
   *
   * **동기적으로 부르는 것이 중요하다.** onRestart 안의 call() 은 stdin 에
   * 그 자리에서 줄을 쓰므로, 되살리기 직후 이어지는 요청보다 set_account 가
   * 반드시 먼저 나간다.
   */
  _notifyRestart () {
    if (!this.onRestart) return
    try {
      const result = this.onRestart(this)
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch { /* 무시 */ }
  }

  /**
   * 쓸 수 있는 stdin 을 돌려준다. 죽어 있으면 되살리기를 한 번 시도한다.
   *
   * 되살리기에 쿨다운을 두는 이유: 원인이 진짜 고장이면 요청마다 프로세스를
   * 새로 띄우며 시스템을 두드리게 된다. 반대로 쿨다운만 지나면 몇 번이고 다시
   * 시도한다 — 사용자가 [동기화] 를 누르는 것이 곧 "다시 해봐 달라"는 뜻이다.
   *
   * @returns {object|null} 쓸 수 있는 stdin, 없으면 null
   */
  _writableStdin () {
    const usable = (p) => p && p.stdin && !p.stdin.destroyed && p.stdin.writable
    if (usable(this.proc)) return this.proc.stdin

    // **왜 못 쓰는지를 남긴다.** "사이드카가 실행 중이 아니다" 만으로는 정지된
    // 것인지, 방금 되살리려다 실패한 것인지, 쿨다운 중인지 알 수 없다 — 실제로
    // 사용자 화면에 그 문구만 뜬 채로 원인을 좁히지 못한 적이 있다. 화면에
    // 그대로 나가는 문구이므로 사람이 읽을 수 있는 말로 적는다.
    // **정지됐는데 앱이 아직 살아서 요청을 보내고 있다면 그 종료는 일어나지
    // 않은 것이다.** stopped 의 뜻은 "지금 종료 중"이고, 진짜 종료 중이라면 앱은
    // 몇 초 안에 사라진다. 그 문턱을 넘도록 살아 있다는 것은 stop() 을 부른
    // 쪽이 끝내 종료하지 않았다는 뜻이므로, 영구히 고장 난 채로 두지 않는다.
    //
    // 이 규칙이 유령 프로세스를 만들지 않는 이유: 진짜 종료 경로는 문턱보다
    // 한참 먼저 프로세스를 끝내므로 여기까지 오지 못한다. 종료 중에 렌더러가
    // 보내는 마지막 저장들도 그 안에 들어온다.
    const stoppedFor = this.stoppedAt ? Date.now() - this.stoppedAt : 0
    if (this.stopped && stoppedFor < this.staleStopMs) {
      this.unusableReason = `정지된 뒤라 다시 띄우지 않는다 (${this.stopReason})`
      return null
    }
    if (this.stopped) {
      // 종료가 일어나지 않았다. 정지를 물리고 다시 띄운다.
      this.stopped = false
      this.stopReason = null
      this.stoppedAt = 0
    }
    const waited = Date.now() - this.lastReviveAt
    if (waited < this.reviveCooldownMs) {
      this.unusableReason =
        `방금 다시 띄웠지만 또 죽었다 (${Math.round(waited / 1000)}초 전 시도, 잠시 뒤 다시 시도한다)`
      return null
    }

    this.lastReviveAt = Date.now()
    this.restarts = 0 // 사람이 다시 부른 것이다. 연쇄 실패 계수는 새로 센다.
    this.start()
    this._notifyRestart()
    if (usable(this.proc)) return this.proc.stdin
    this.unusableReason = '다시 띄우지 못했다'
    return null
  }

  _onLine (line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return // 사이드카가 찍은 비-JSON 출력은 무시한다
    }
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) {
      const err = new Error(msg.error.message)
      err.code = msg.error.code
      entry.reject(err)
    } else {
      entry.resolve(msg.result)
    }
  }

  _onStderr (line) {
    this.stderrTail.push(line)
    while (this.stderrTail.length > this.stderrTailLines) this.stderrTail.shift()
  }

  _withStderrTail (message) {
    if (this.stderrTail.length === 0) return message
    return `${message}\n\n마지막 오류 출력:\n${this.stderrTail.join('\n')}`
  }

  _rejectAll (code, message) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      const err = new Error(message)
      err.code = code
      entry.reject(err)
    }
    this.pending.clear()
  }

  call (method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const err = new Error(`응답 없음: ${method}`)
        err.code = 'TIMEOUT'
        reject(err)
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        // 재시작 한도를 넘긴 뒤에도 this.proc 는 죽은 자식을 가리킨 채 남는다.
        // 그 stdin 에 쓰면 응답이 영영 오지 않아 30초 타임아웃까지 매달리거나,
        // 스트림이 'error' 를 던져 앱 전체를 날린다. 쓰기 전에 확인하고,
        // 죽어 있으면 _writableStdin 이 되살리기를 한 번 시도한다.
        const stdin = this._writableStdin()
        if (!stdin) throw new Error(`사이드카가 실행 중이 아니다 — ${this.unusableReason}`)
        stdin.write(JSON.stringify({ id, method, params }) + '\n')
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        const dead = new Error(`요청을 보내지 못했다 (${method}): ${err.message}`)
        dead.code = 'SIDECAR_DEAD'
        reject(dead)
      }
    })
  }

  stop (reason = '이유 없음') {
    // 멱등하다. 종료 경로가 여러 개라 (window-all-closed / before-quit /
    // will-quit / session-end) 겹쳐 불리는 것이 정상이다.
    if (this.stopped) return
    this.stopped = true // 의도적 종료는 재시작하지 않는다
    this.stopReason = reason
    this.stoppedAt = Date.now()
    this._rejectAll('SIDECAR_DEAD', '사이드카 정지 요청')
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}

module.exports = { Sidecar }
