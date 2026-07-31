'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { resolveSidecarCommand } = require('../sidecar-path')

test('개발 중에는 시스템 python 으로 스크립트를 실행한다', () => {
  const r = resolveSidecarCommand(false, '/ignored', '/proj/app')
  assert.strictEqual(r.command, 'python')
  assert.strictEqual(r.args[0], path.join('/proj', 'keep_service.py'))
})

test('배포본에서는 번들된 실행파일을 인자 없이 실행한다', () => {
  const r = resolveSidecarCommand(true, '/app/resources', '/ignored')
  assert.strictEqual(r.command, path.join('/app/resources', 'keep_service.exe'))
  assert.deepStrictEqual(r.args, [])
})
