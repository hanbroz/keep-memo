'use strict'
const path = require('node:path')

/**
 * 개발 중에는 시스템 python 으로 소스를 돌리고, 배포본에서는 PyInstaller 로
 * 만든 단일 실행파일을 쓴다. 사용자 PC 에 Python 설치를 요구하지 않는다.
 */
function resolveSidecarCommand (isPackaged, resourcesPath, dirname) {
  if (isPackaged) {
    const exe = process.platform === 'win32' ? 'keep_service.exe' : 'keep_service'
    return { command: path.join(resourcesPath, exe), args: [] }
  }
  return { command: 'python', args: [path.join(dirname, '..', 'keep_service.py')] }
}

module.exports = { resolveSidecarCommand }
