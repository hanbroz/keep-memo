'use strict'
// 테스트용 가짜 사이드카. stdin 의 각 줄을 읽어 약속된 응답을 낸다.
const readline = require('node:readline')

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  if (req.method === 'echo') {
    process.stdout.write(JSON.stringify({ id: req.id, result: req.params }) + '\n')
  } else if (req.method === 'boom') {
    process.stdout.write(JSON.stringify({
      id: req.id, error: { code: 'AUTH_REQUIRED', message: '토큰 없음' }
    }) + '\n')
  } else if (req.method === 'silent') {
    // 일부러 응답하지 않는다 -> 타임아웃 경로 검증
  } else if (req.method === 'die') {
    process.exit(3)
  }
})
