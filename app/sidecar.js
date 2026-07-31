'use strict'
const { spawn } = require('node:child_process')
const readline = require('node:readline')

/**
 * Python 사이드카와 줄 단위 JSON-RPC 로 대화한다.
 * 이 클래스는 배관만 안다. Keep 도메인(노트, 라벨, 색상)은 모른다.
 */
class Sidecar {
  constructor (command, args = [], { timeoutMs = 30000, maxRestarts = 3, onDead = null } = {}) {
    this.command = command
    this.args = args
    this.timeoutMs = timeoutMs
    this.maxRestarts = maxRestarts
    this.onDead = onDead
    this.restarts = 0
    this.stopped = false
    this.pending = new Map()
    this.nextId = 1
    this.proc = null
  }

  start () {
    this.proc = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    readline.createInterface({ input: this.proc.stdout })
      .on('line', (line) => this._onLine(line))
    this.proc.on('exit', (code) => this._onExit(`사이드카 종료: ${code}`))
    this.proc.on('error', (err) => this._onExit(err.message))
    return this
  }

  _onExit (message) {
    this._rejectAll('SIDECAR_DEAD', message)
    if (this.stopped) return
    if (this.restarts >= this.maxRestarts) {
      // 계속 죽는다면 재시작해봐야 같은 결과다. 사용자에게 알리고 멈춘다.
      if (this.onDead) this.onDead(message)
      return
    }
    this.restarts++
    this.start()
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
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  stop () {
    this.stopped = true // 의도적 종료는 재시작하지 않는다
    this._rejectAll('SIDECAR_DEAD', '사이드카 정지 요청')
    if (this.proc) this.proc.kill()
  }
}

module.exports = { Sidecar }
