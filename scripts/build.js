'use strict'
/**
 * 포터블 exe 빌드 래퍼.
 *
 * 목적은 하나: 빌드된 exe 가 "최신인지" 파일명과 Windows 파일 속성만 보고
 * 바로 알 수 있게 만드는 것. 그래서:
 *
 *   1. 이 프로젝트의 소스 파일(app/**, keep_service.py, keep_probe.py,
 *      package.json, keep_service.spec) 중 가장 최근에 수정된 시각을
 *      "버전"으로 쓴다. git 추적 파일만 대상으로 하므로 node_modules,
 *      dist, dist-py, docs 등은 자동으로 빠진다.
 *   2. 그 값을 electron-builder 에 세 가지 형태로 전달한다:
 *        - artifactName 에 들어갈 "yyyy.MM.dd.HH.mm" 문자열 (env 매크로)
 *        - Windows FileVersion 리소스에 들어갈 4자리 숫자 버전
 *          (buildVersion, CLI 오버라이드로 전달 — package.json 의
 *          buildVersion 필드는 매크로 확장이 안 되기 때문)
 *        - package.json 의 version 에 심어질 3자리 semver 버전
 *          (extraMetadata.version, CLI 오버라이드로 전달 — 저장소의
 *          package.json 파일 자체는 건드리지 않는다). electron-builder
 *          의 portable 타겟은 %TEMP% 밑에 "appId-version" 이름의 디렉터리로
 *          압축을 풀고 이미 있으면 재사용하므로, version 이 매 빌드마다
 *          바뀌지 않으면 오래된 빌드가 풀어둔 파일과 새 빌드가 뒤섞여
 *          실행될 수 있다. 이 필드가 바로 그 충돌을 막는다.
 *
 * 그리고 Python 사이드카(dist-py/keep_service.exe)가 소스보다 오래됐으면
 * electron-builder 를 부르기 전에 먼저 PyInstaller 로 다시 굽는다. 이걸
 * 안 하면 "최신"이라고 찍힌 exe 안에 오래된 사이드카가 들어갈 수 있다 —
 * 이 스크립트가 막으려는 바로 그 실패 모드다.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')

function pad2 (n) {
  return String(n).padStart(2, '0')
}

/** git 이 추적하는 파일 목록. .gitignore 된 것(dist/, dist-py/, node_modules/ 등)은 자동 제외. */
function listTrackedFiles () {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** 버전 스탬프 산정에 포함할 "이 프로젝트 자신의 소스"인지 판단. */
function isStampSource (relPath) {
  return (
    relPath.startsWith('app/') ||
    relPath === 'keep_service.py' ||
    relPath === 'keep_probe.py' ||
    relPath === 'package.json' ||
    relPath === 'keep_service.spec'
  )
}

function newestMtime (files) {
  let newest = null
  let newestFile = null
  for (const rel of files) {
    const abs = path.join(ROOT, rel)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      continue // git 에는 있으나 워킹트리에 없는 경우(드묾) - 건너뜀
    }
    if (newest === null || stat.mtime > newest) {
      newest = stat.mtime
      newestFile = rel
    }
  }
  if (newest === null) {
    throw new Error('버전 스탬프를 산정할 소스 파일을 찾지 못했습니다')
  }
  return { mtime: newest, file: newestFile }
}

/**
 * date 로부터 세 가지 스탬프를 만든다. 로컬 시각 기준(사용자가 보는 시계와
 * 일치해야 하므로 UTC 게터를 쓰지 않는다).
 *
 *  - fullStamp: "yyyy.MM.dd.HH.mm" — 파일명(artifactName)에 들어간다.
 *  - winVersion: "yyyy.MMdd.HHmm.0" 형태의 4자리 숫자 버전 — Windows
 *    FileVersion 리소스는 각 자리가 16비트(<=65535)여야 하므로, 월*100+일,
 *    시*100+분 로 압축한다. 실사용 범위(연도 <=65535, 월일 <=1231,
 *    시분 <=2359)에서는 항상 유효하다.
 *  - semverVersion: "yyyy.MMdd.HHmm" — winVersion 과 동일한 월/일, 시/분
 *    압축 값을 그대로 재사용하되 끝의 ".0" 을 뗀 3자리 숫자 버전. 유효한
 *    semver(major.minor.patch)이면서 같은 해 안에서는 시간순 정렬도
 *    보장된다. package.json 의 version 오버라이드(extraMetadata.version)
 *    에 쓰인다.
 */
function formatStamps (date) {
  const yyyy = date.getFullYear()
  const M = date.getMonth() + 1
  const D = date.getDate()
  const H = date.getHours()
  const m = date.getMinutes()
  const mmdd = M * 100 + D
  const hhmm = H * 100 + m
  const fullStamp = `${yyyy}.${pad2(M)}.${pad2(D)}.${pad2(H)}.${pad2(m)}`
  const winVersion = `${yyyy}.${mmdd}.${hhmm}.0`
  const semverVersion = `${yyyy}.${mmdd}.${hhmm}`
  return { fullStamp, winVersion, semverVersion }
}

/** Python 사이드카가 소스보다 오래됐는지(또는 아예 없는지) 확인. */
function checkSidecarStaleness () {
  const exePath = path.join(ROOT, 'dist-py', 'keep_service.exe')
  const pySrc = path.join(ROOT, 'keep_service.py')
  const specSrc = path.join(ROOT, 'keep_service.spec')

  let exeStat
  try {
    exeStat = fs.statSync(exePath)
  } catch {
    return { rebuild: true, reason: 'dist-py/keep_service.exe 가 없습니다' }
  }

  const pyStat = fs.statSync(pySrc)
  if (pyStat.mtime > exeStat.mtime) {
    return { rebuild: true, reason: 'keep_service.py 가 dist-py/keep_service.exe 보다 최신입니다' }
  }

  const specStat = fs.statSync(specSrc)
  if (specStat.mtime > exeStat.mtime) {
    return { rebuild: true, reason: 'keep_service.spec 이 dist-py/keep_service.exe 보다 최신입니다' }
  }

  return { rebuild: false }
}

function rebuildSidecar () {
  const result = spawnSync(
    'python',
    ['-m', 'PyInstaller', 'keep_service.spec', '--clean', '--distpath', 'dist-py'],
    { cwd: ROOT, stdio: 'inherit' }
  )
  if (result.error) {
    console.error(`[build] PyInstaller 실행 실패: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[build] PyInstaller 빌드 실패 (exit ${result.status})`)
    process.exit(result.status || 1)
  }
}

function main () {
  const files = listTrackedFiles().filter(isStampSource)
  const { mtime, file } = newestMtime(files)
  const { fullStamp, winVersion, semverVersion } = formatStamps(mtime)

  console.log(`[build] 버전 스탬프 기준 파일: ${file} (${mtime.toString()})`)
  console.log(`[build] 파일명 스탬프: ${fullStamp}`)
  console.log(`[build] Windows FileVersion: ${winVersion}`)
  console.log(`[build] package.json version (extraMetadata): ${semverVersion}`)

  const staleness = checkSidecarStaleness()
  if (staleness.rebuild) {
    console.log(`[build] 사이드카 재빌드 필요 — ${staleness.reason}`)
    console.log('[build] PyInstaller 로 dist-py/keep_service.exe 를 다시 빌드합니다...')
    rebuildSidecar()
  } else {
    console.log('[build] dist-py/keep_service.exe 가 최신입니다 — PyInstaller 재빌드를 건너뜁니다')
  }

  const cliPath = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js')
  const args = [
    cliPath,
    '--win',
    `--config.buildVersion=${winVersion}`,
    `--config.extraMetadata.version=${semverVersion}`,
  ]
  console.log(`[build] electron-builder 실행 (buildVersion=${winVersion}, extraMetadata.version=${semverVersion}, artifactName 스탬프=${fullStamp})`)

  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, BUILD_STAMP: fullStamp },
  })
  if (result.error) {
    console.error(`[build] electron-builder 실행 실패: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[build] electron-builder 빌드 실패 (exit ${result.status})`)
    process.exit(result.status || 1)
  }
}

main()
