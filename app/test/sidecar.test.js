'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { Sidecar } = require('../sidecar')

const FAKE = path.join(__dirname, 'fake-sidecar.js')

function spawnFake (opts) {
  return new Sidecar(process.execPath, [FAKE], opts).start()
}

test('요청과 응답이 id 로 짝지어진다', async () => {
  const s = spawnFake()
  const [a, b] = await Promise.all([
    s.call('echo', { n: 1 }),
    s.call('echo', { n: 2 })
  ])
  assert.deepStrictEqual([a.n, b.n], [1, 2])
  s.stop()
})

test('서버 에러는 code 가 붙은 Error 로 거부된다', async () => {
  const s = spawnFake()
  await assert.rejects(s.call('boom'), (err) => {
    assert.strictEqual(err.code, 'AUTH_REQUIRED')
    assert.strictEqual(err.message, '토큰 없음')
    return true
  })
  s.stop()
})

test('응답이 없으면 TIMEOUT 으로 거부된다', async () => {
  const s = spawnFake({ timeoutMs: 200 })
  await assert.rejects(s.call('silent'), (err) => err.code === 'TIMEOUT')
  s.stop()
})

test('사이드카가 죽으면 대기 중인 요청이 전부 거부된다', async () => {
  const s = spawnFake({ timeoutMs: 5000 })
  const pending = s.call('silent')
  s.call('die').catch(() => {})
  await assert.rejects(pending, (err) => err.code === 'SIDECAR_DEAD')
  s.stop()
})

test('사이드카가 죽으면 최대 3회까지 자동 재시작한다', async () => {
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 3 })
  for (let i = 0; i < 3; i++) {
    s.call('die').catch(() => {})
    await new Promise((r) => setTimeout(r, 120))
  }
  assert.strictEqual(s.restarts, 3)
  // 재시작된 프로세스가 살아 있어야 한다
  assert.deepStrictEqual(await s.call('echo', { ok: 1 }), { ok: 1 })
  s.stop()
})

test('재시작 후 onRestart 로 세션 상태를 다시 세울 수 있다', async () => {
  // 재시작된 프로세스는 set_account 이전 상태다. onRestart 가 없으면(또는
  // 새 프로세스가 아직 못 받는 시점에 불리면) 이후 모든 호출이 AUTH_REQUIRED
  // 로 떨어지고 재로그인해도 낫지 않는다.
  let s = null
  const restored = []
  s = spawnFake({
    timeoutMs: 5000,
    maxRestarts: 2,
    onRestart: async (sc) => {
      assert.strictEqual(sc, s) // 훅은 사이드카 자신을 받는다
      restored.push(await sc.call('echo', { setAccount: true }))
    }
  })

  s.call('die').catch(() => {})
  await new Promise((r) => setTimeout(r, 300))

  assert.strictEqual(s.restarts, 1)
  // 훅이 불렸을 뿐 아니라, 그 안에서 보낸 호출이 새 프로세스에 실제로 닿았다.
  assert.deepStrictEqual(restored, [{ setAccount: true }])
  s.stop()
})

test('재시작 한도를 넘으면 onRestart 를 부르지 않는다', async () => {
  let restartCalls = 0
  const s = spawnFake({
    timeoutMs: 5000,
    maxRestarts: 1,
    onRestart: () => { restartCalls++ }
  })
  for (let i = 0; i < 2; i++) {
    s.call('die').catch(() => {})
    await new Promise((r) => setTimeout(r, 150))
  }
  assert.strictEqual(restartCalls, 1) // 재시작은 1회뿐이었으므로 훅도 1회
  s.stop()
})

test('한도를 넘겨 죽은 뒤에도 다음 요청이 되살린다', async () => {
  // **실제로 겪은 경로다.** 시스템 자원이 말라 프로세스를 못 띄우는 동안
  // 사이드카가 연달아 죽어 예산이 소진됐고, 자원이 회복된 뒤에도 앱이 영영
  // 죽은 상태로 남아 목록도 저장도 동기화도 되지 않았다. 되살릴 길이 앱
  // 재시작뿐이면 그것은 고장이다.
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 0, reviveCooldownMs: 0 })
  s.call('die').catch(() => {})
  await new Promise((r) => setTimeout(r, 150))

  const res = await s.call('echo', { n: 7 })
  assert.strictEqual(res.n, 7, '되살아나 응답해야 한다')
  s.stop()
})

test('되살리기에는 쿨다운이 있다 — 진짜 고장에 시스템을 두드리지 않는다', async () => {
  // 원인이 일시적이지 않다면 요청마다 프로세스를 새로 띄우게 되고, 그것이
  // 바로 자원을 마르게 한 그 상황을 더 나쁘게 만든다. 쿨다운 안에서는
  // 앱을 죽이지 않고 SIDECAR_DEAD 로 거부한다(죽은 stdin 에 쓰지 않는다).
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 0, reviveCooldownMs: 60000 })
  s.call('die').catch(() => {})
  await new Promise((r) => setTimeout(r, 150))
  await s.call('echo', { n: 1 }) // 첫 되살리기는 언제나 허용된다

  s.call('die').catch(() => {})
  await new Promise((r) => setTimeout(r, 150))
  await assert.rejects(s.call('echo', { n: 2 }), (err) => err.code === 'SIDECAR_DEAD')
  s.stop()
})

test('오래 살아 있다 죽으면 재시작 예산이 되돌아온다', async () => {
  // maxRestarts 는 **연달아 빠르게** 죽는 것(crash loop)의 한도여야 한다.
  // 예전에는 앱 수명 전체를 통틀어 3회였고, 그래서 몇 시간에 걸쳐 어쩌다 세 번
  // 죽은 앱이 그 뒤로 영영 자동 재시작을 못 받았다.
  // healthyUptimeMs: 0 이면 모든 죽음이 "잘 살다 죽은 것"으로 취급된다.
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 1, healthyUptimeMs: 0 })
  for (let i = 0; i < 3; i++) {
    s.call('die').catch(() => {})
    await new Promise((r) => setTimeout(r, 150))
  }
  assert.strictEqual(s.restarts, 1, '매번 회복되므로 누적되지 않는다')
  assert.strictEqual((await s.call('echo', { n: 9 })).n, 9, '세 번 죽고도 살아 있다')
  s.stop()
})

test('사이드카 stderr 마지막 줄이 onDead 메시지에 실린다', async () => {
  // 패키징본은 console=False 라 파이썬 트레이스백을 볼 다른 경로가 없다.
  let deadMessage = null
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 0, onDead: (m) => { deadMessage = m } })
  await s.call('noisy', { line: 'Traceback (most recent call last):' })
  await new Promise((r) => setTimeout(r, 50))
  s.call('die').catch(() => {})
  await new Promise((r) => setTimeout(r, 200))
  assert.match(deadMessage, /Traceback \(most recent call last\):/)
  s.stop()
})

test('stop() 은 여러 번 불려도 안전하다', () => {
  // 종료 경로가 window-all-closed / before-quit / will-quit / session-end 로
  // 여러 개라 겹쳐 불리는 것이 정상이다.
  const s = spawnFake()
  s.stop()
  s.stop()
  assert.strictEqual(s.stopped, true)
})

test('재시작 한도를 넘으면 포기하고 onDead 를 호출한다', async () => {
  let deadCalled = false
  const s = spawnFake({ timeoutMs: 5000, maxRestarts: 1, onDead: () => { deadCalled = true } })
  for (let i = 0; i < 2; i++) {
    s.call('die').catch(() => {})
    await new Promise((r) => setTimeout(r, 120))
  }
  assert.strictEqual(deadCalled, true)
})

test('정지됐는데 앱이 계속 살아 있으면 다음 요청이 되살린다', async () => {
  // **실제로 겪은 고장이다.** 앱은 멀쩡히 떠 있는데 사이드카만 정지된 채로
  // 남아 모든 요청이 "정지된 뒤라 다시 띄우지 않는다" 로 떨어졌다. stopped 의
  // 뜻은 "지금 종료 중"이고 진짜 종료 중이면 앱은 몇 초 안에 사라지므로,
  // 그 문턱을 넘도록 요청이 온다는 것 자체가 그 종료가 일어나지 않았다는 증거다.
  const s = spawnFake({ timeoutMs: 5000, staleStopMs: 0, reviveCooldownMs: 0 })
  await s.call('echo', { n: 1 })
  s.stop('가짜 session-end')

  const res = await s.call('echo', { n: 2 })
  assert.strictEqual(res.n, 2, '되살아나 응답해야 한다')
  s.stop()
})

test('정지 직후에는 되살리지 않는다 — 진짜 종료 중일 수 있다', async () => {
  // 종료 절차가 도는 동안 되살리면 파이썬 자식이 유령으로 남는다. 문턱 안에서는
  // 거부하고, 왜 거부했는지(누가 세웠는지)를 문구에 싣는다.
  const s = spawnFake({ timeoutMs: 5000, staleStopMs: 60000 })
  await s.call('echo', { n: 1 })
  s.stop('before-quit')

  await assert.rejects(s.call('echo', { n: 2 }), (err) => {
    assert.strictEqual(err.code, 'SIDECAR_DEAD')
    assert.match(err.message, /before-quit/, '누가 세웠는지가 문구에 있어야 한다')
    return true
  })
  s.stop()
})

test('갈아탄 뒤 도착한 옛 프로세스의 부고는 무시된다', async () => {
  // 죽인 프로세스의 'exit' 는 다음 프로세스를 띄운 **뒤에** 도착한다. 그때
  // 핸들러가 그냥 돌면 방금 살린 자식을 또 재시작으로 갈아치워 살아 있는
  // 프로세스를 유령으로 흘린다. 그렇게 샌 프로세스들 때문에 테스트가 아예
  // 끝나지 않았다(노드가 종료를 못 한다).
  const s = spawnFake({ timeoutMs: 5000, staleStopMs: 0, reviveCooldownMs: 0 })
  await s.call('echo', { n: 1 })
  s.stop('가짜 session-end')
  await s.call('echo', { n: 2 }) // 되살아난다

  const revived = s.proc
  await new Promise((r) => setTimeout(r, 300)) // 옛 부고가 도착할 시간
  assert.strictEqual(s.proc, revived, '되살린 프로세스가 그대로 남아야 한다')
  assert.strictEqual(s.restarts, 0, '부고에 반응해 재시작하지 않았다')
  assert.strictEqual((await s.call('echo', { n: 3 })).n, 3)
  s.stop()
})
