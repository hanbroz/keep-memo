'use strict'
const { spawn } = require('node:child_process')
const readline = require('node:readline')

// 사이드카가 죽었을 때 보여줄 stderr 마지막 줄 수. 패키징본은 console=False
// 라 이 링버퍼 말고는 파이썬 쪽 실패를 볼 수 있는 경로가 없다.
const STDERR_TAIL_LINES = 20

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
    stderrTailLines = STDERR_TAIL_LINES
  } = {}) {
    this.command = command
    this.args = args
    this.timeoutMs = timeoutMs
    this.maxRestarts = maxRestarts
    this.onDead = onDead
    // 재시작된 프로세스는 백지 상태다(set_account 이전). 감독자가 세션 상태를
    // 다시 세울 기회를 여기서 준다 — 이게 없으면 "재시작 = 영구 고장"이 된다.
    this.onRestart = onRestart
    this.stderrTailLines = stderrTailLines
    this.stderrTail = []
    this.restarts = 0
    this.stopped = false
    this.pending = new Map()
    this.nextId = 1
    this.proc = null
  }

  start () {
    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // keep_service.py 는 진입점에서 stdin/stdout 을 UTF-8 로 reconfigure
      // 하지만, 그 줄이 실행되기 전(예: import 단계에서 터지는 트레이스백)에는
      // 여전히 OS 로캘 코드페이지 — 한국어 Windows 에서는 cp949 — 를 쓴다.
      // 그 창을 없애려면 프로세스 자체를 UTF-8 로 띄워야 한다. 이게 없으면
      // 가장 필요한 순간(초기화 실패 메시지)에 정작 그 메시지가 또 깨진다.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    })
    readline.createInterface({ input: this.proc.stdout })
      .on('line', (line) => this._onLine(line))
    // stderr 는 반드시 비워야 한다. 읽지 않으면 파이프 버퍼(Windows 약 64KB)가
    // 차는 순간 자식이 write 에서 영구히 멈춘다 — 죽지 않으니 재시작도 안 걸리고
    // 모든 호출이 타임아웃만 낸다. 여기 담기는 것은 Python 이 stderr 로 뱉은
    // 것뿐이다. RPC 요청/응답 본문은 절대 담지 않는다 — 그쪽에는 계정 전체
    // 권한을 가진 master token 이 지나간다.
    readline.createInterface({ input: this.proc.stderr })
      .on('line', (line) => this._onStderr(line))
    // 죽은 파이프에 쓰면 스트림이 'error' 를 낸다. 리스너가 없으면 그게 그대로
    // Electron 메인 프로세스의 uncaughtException 이 되어 앱 전체가 사라진다 —
    // 열려 있던 포스트잇과 미저장 편집을 전부 데리고. 실제 실패 처리는 'exit'
    // 와 call() 의 가드가 하므로 여기서는 삼키기만 한다.
    this.proc.stdin.on('error', () => {})
    this.proc.on('exit', (code) => this._onExit(`사이드카 종료: ${code}`))
    this.proc.on('error', (err) => this._onExit(err.message))
    return this
  }

  _onExit (message) {
    this._rejectAll('SIDECAR_DEAD', message)
    if (this.stopped) return
    if (this.restarts >= this.maxRestarts) {
      // 계속 죽는다면 재시작해봐야 같은 결과다. 사용자에게 알리고 멈춘다.
      if (this.onDead) this.onDead(this._withStderrTail(message))
      return
    }
    this.restarts++
    this.start()
    // 프로세스는 살아났지만 세션 상태는 백지다. 감독자가 set_account 를 다시
    // 보내지 못하면 이후 모든 호출이 AUTH_REQUIRED 로 떨어진다. 실패해도 여기서
    // 할 수 있는 일은 없으므로 삼킨다 — 다음 실제 호출이 사용자에게 알린다.
    if (this.onRestart) {
      try {
        const result = this.onRestart(this)
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch { /* 무시 */ }
    }
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
        const stdin = this.proc && this.proc.stdin
        // 재시작 한도를 넘긴 뒤에도 this.proc 는 죽은 자식을 가리킨 채 남는다.
        // 그 stdin 에 쓰면 응답이 영영 오지 않아 30초 타임아웃까지 매달리거나,
        // 스트림이 'error' 를 던져 앱 전체를 날린다. 쓰기 전에 확인한다.
        if (!stdin || stdin.destroyed || !stdin.writable) {
          throw new Error('사이드카가 실행 중이 아니다')
        }
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

  stop () {
    // 멱등하다. 종료 경로가 여러 개라 (window-all-closed / before-quit /
    // will-quit / session-end) 겹쳐 불리는 것이 정상이다.
    if (this.stopped) return
    this.stopped = true // 의도적 종료는 재시작하지 않는다
    this._rejectAll('SIDECAR_DEAD', '사이드카 정지 요청')
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}

module.exports = { Sidecar }
