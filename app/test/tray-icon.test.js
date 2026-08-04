'use strict'
const test = require('node:test')
const assert = require('node:assert')
const zlib = require('node:zlib')
const {
  TRAY_ICON_PNG_BASE64, TRAY_ICON_DATA_URL, trayIconPngBuffer
} = require('../tray-icon')

// 이 파일이 하는 일: 트레이 아이콘이 "있다고 치는" 대신 실제로 유효한 PNG 인지
// 바이트 단위로 확인한다. 아이콘이 비면 트레이에 아무것도 안 보이고, 그러면
// 창 없이 앱이 살아 있어도 되는 유일한 근거가 사라진다 — 고치려던 버그로
// 그대로 돌아간다. Electron 없이 검사할 수 있게 아이콘을 소스 안의 base64 로
// 둔 이유이기도 하다.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  return table
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** PNG 청크를 순서대로 훑는다. 길이가 어긋나면 그 자리에서 실패한다. */
function readChunks (buf) {
  const chunks = []
  let off = PNG_SIGNATURE.length
  while (off < buf.length) {
    assert.ok(off + 8 <= buf.length, `청크 헤더가 잘렸다 (offset ${off})`)
    const length = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString('ascii')
    const end = off + 12 + length
    assert.ok(end <= buf.length, `청크 ${type} 의 길이가 파일을 넘어간다`)
    chunks.push({
      type,
      data: buf.subarray(off + 8, off + 8 + length),
      declaredCrc: buf.readUInt32BE(off + 8 + length),
      typeAndData: buf.subarray(off + 4, off + 8 + length)
    })
    off = end
  }
  return chunks
}

test('PNG 시그니처로 시작한다', () => {
  const buf = trayIconPngBuffer()
  assert.ok(buf.length > 0, '아이콘이 비어 있다')
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE))
})

test('청크 구성이 IHDR → IDAT → IEND 이고 CRC 가 전부 맞는다', () => {
  const chunks = readChunks(trayIconPngBuffer())
  assert.deepStrictEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND'])
  for (const c of chunks) {
    assert.strictEqual(crc32(c.typeAndData), c.declaredCrc, `${c.type} 의 CRC 가 어긋난다`)
  }
})

test('IHDR 이 32x32 8비트 RGBA 를 선언한다', () => {
  const [ihdr] = readChunks(trayIconPngBuffer())
  assert.strictEqual(ihdr.data.readUInt32BE(0), 32, '너비')
  assert.strictEqual(ihdr.data.readUInt32BE(4), 32, '높이')
  assert.strictEqual(ihdr.data[8], 8, '비트 깊이')
  assert.strictEqual(ihdr.data[9], 6, '컬러 타입 6 = RGBA (투명 배경이 필요하다)')
  assert.strictEqual(ihdr.data[12], 0, '인터레이스 없음')
})

test('IDAT 이 실제로 풀리고 32행이 온전히 들어 있다', () => {
  const idat = readChunks(trayIconPngBuffer()).find((c) => c.type === 'IDAT')
  const raw = zlib.inflateSync(idat.data)
  // 행마다 필터 바이트 1개 + 픽셀 32개 * 4채널
  assert.strictEqual(raw.length, 32 * (1 + 32 * 4))
  for (let y = 0; y < 32; y++) {
    assert.strictEqual(raw[y * 129], 0, `${y}행의 필터 타입이 0(None)이 아니다`)
  }
})

test('빈 그림이 아니다 — 불투명한 픽셀이 아이콘의 절반 이상을 채운다', () => {
  // 전부 투명한 PNG 도 위 검사는 전부 통과한다. 트레이에서는 그것이 곧
  // "아이콘 없음"이므로 픽셀까지 본다.
  const idat = readChunks(trayIconPngBuffer()).find((c) => c.type === 'IDAT')
  const raw = zlib.inflateSync(idat.data)
  let opaque = 0
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (raw[y * 129 + 1 + x * 4 + 3] === 255) opaque++
    }
  }
  assert.ok(opaque > 32 * 32 * 0.5, `불투명 픽셀이 ${opaque}개뿐이다`)
})

test('가장자리는 투명하다 — 잘린 사각형이 아니라 아이콘 모양이 있다', () => {
  const idat = readChunks(trayIconPngBuffer()).find((c) => c.type === 'IDAT')
  const raw = zlib.inflateSync(idat.data)
  const alphaAt = (x, y) => raw[y * 129 + 1 + x * 4 + 3]
  for (const [x, y] of [[0, 0], [31, 0], [0, 31], [31, 31]]) {
    assert.strictEqual(alphaAt(x, y), 0, `모서리 (${x},${y}) 가 투명하지 않다`)
  }
})

test('data URL 이 base64 문자열과 짝이 맞는다', () => {
  assert.strictEqual(TRAY_ICON_DATA_URL, `data:image/png;base64,${TRAY_ICON_PNG_BASE64}`)
  // 왕복이 손실 없이 되어야 문자열이 중간에 잘리지 않았다고 말할 수 있다.
  assert.strictEqual(trayIconPngBuffer().toString('base64'), TRAY_ICON_PNG_BASE64)
})

test('앱 아이콘(.ico)과 트레이 아이콘이 갈라지지 않았다', () => {
  // 트레이 아이콘은 google-keep-electron.ico 에서 구운 것이고, 그 .ico 는
  // exe 아이콘이기도 하다(package.json 의 build.win.icon). 아이콘만 바꾸고
  // `node scripts/make-tray-icon.js` 를 안 돌리면 exe 는 새 아이콘, 트레이는
  // 옛 아이콘이 되어 갈라진다 — 눈으로는 알아채기 어렵고 원인을 짚기는 더
  // 어렵다. 여기서 다시 구워 바이트가 같은지 본다.
  //
  // 이 require 는 파일을 쓰지 않는다(make-tray-icon.js 는 require.main 일
  // 때만 main() 을 부른다).
  const { buildTrayIconPng } = require('../../scripts/make-tray-icon')
  assert.deepStrictEqual(
    buildTrayIconPng(), trayIconPngBuffer(),
    'app/tray-icon.js 가 google-keep-electron.ico 와 다르다 — node scripts/make-tray-icon.js 를 돌릴 것'
  )
})

test('Electron 없이도 require 된다', () => {
  // 아이콘이 파일이 아니라 소스에 있는 덕에 테스트가 Electron 을 띄우지 않고도
  // 검사할 수 있다. 배포본의 asar 안에서도 같은 이유로 항상 읽힌다.
  assert.strictEqual(typeof TRAY_ICON_PNG_BASE64, 'string')
  assert.ok(!Object.keys(require.cache).some((p) => /[\\/]electron[\\/]/.test(p)))
})
