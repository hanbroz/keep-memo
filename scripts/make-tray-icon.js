'use strict'
/**
 * 트레이 아이콘(app/tray-icon.js)을 다시 만든다.
 *
 *   node scripts/make-tray-icon.js
 *
 * 픽셀은 저장소의 앱 아이콘(google-keep-electron.ico)에서 온다. exe 아이콘과
 * 트레이 아이콘이 **같은 원본 한 장**을 보게 하는 것이 요점이다 — 예전에는
 * 이 스크립트가 포스트잇을 직접 그렸고, 그래서 앱 아이콘을 바꿔도 트레이만
 * 옛 그림으로 남았다.
 *
 * 왜 이런 방식인가:
 *
 *  1. 이 앱은 네트워크에서 아이콘을 받아오지 않는다. 아이콘 하나 때문에
 *     오프라인에서 트레이가 비면 앱에 닿을 길이 사라진다. 원본은 저장소에
 *     같이 있는 파일이고, 읽고 다시 인코딩하는 데 node:zlib 말고는 아무것도
 *     쓰지 않는다 — 외부 이미지 라이브러리도, 내려받는 에셋도 없다.
 *  2. 결과물은 .png 파일이 아니라 base64 문자열을 담은 .js 모듈이다.
 *     배포본은 app/ 전체가 app.asar 로 묶이는데, asar 안의 경로를 이미지
 *     로더가 못 읽는 경우가 있다. 그러면 아이콘이 비고, "창이 없어도 앱이
 *     살아 있다"의 유일한 근거가 사라진다. 문자열은 asar 여부와 무관하다.
 *     .ico 를 런타임에 읽지 않고 여기서 미리 굽는 이유가 그것이다.
 *  3. 생성 코드를 저장소에 남겨 두는 이유: base64 덩어리만 있으면 아무도
 *     그 안에 뭐가 들었는지 확인하거나 고칠 수 없다.
 *
 * **다시 인코딩하는 이유**: .ico 안의 32x32 PNG 를 그대로 꺼내 쓰면 안 된다.
 * 그쪽은 IDAT 이 여러 조각이고 행 필터도 0 이 아닌데, app/test/tray-icon.test.js
 * 는 IHDR → IDAT → IEND 단일 IDAT 에 모든 행 필터 0 을 요구한다. 그 검사가
 * 까다로워서가 아니라, 그래야 Electron 없이 바이트만 보고 "이 아이콘이 진짜
 * 그려지는 그림인지"를 확인할 수 있기 때문이다. 그래서 픽셀만 꺼내
 * (decodePng) 아래 인코더로 다시 굽는다.
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'app', 'tray-icon.js')
const SOURCE_ICON = path.join(ROOT, 'google-keep-electron.ico')

// Windows 트레이는 논리 16x16 에 DPI 배율을 곱한 크기를 쓴다(125% → 20px,
// 150% → 24px, 200% → 32px). 32x32 하나만 두고 축소하게 하면 모든 배율을
// 덮는다.
const W = 32
const H = 32

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// --- .ico 에서 픽셀 꺼내기 --------------------------------------------------

/**
 * .ico 에서 size x size 항목의 PNG 바이트를 꺼낸다.
 *
 * 못 찾거나 PNG 가 아니면 던진다. 조용히 다른 크기로 넘어가지 않는 것이
 * 중요하다 — 트레이 아이콘이 흐릿해진 것을 눈으로 알아채기는 어렵고,
 * 알아채더라도 원인이 여기라고 짐작하기는 더 어렵다.
 */
function extractIcoPng (icoBuf, size) {
  if (icoBuf.readUInt16LE(0) !== 0 || icoBuf.readUInt16LE(2) !== 1) {
    throw new Error(`${SOURCE_ICON} 가 .ico 가 아니다`)
  }
  const count = icoBuf.readUInt16LE(4)
  const found = []
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    // .ico 에서 0 은 256 을 뜻한다(한 바이트에 256 이 안 들어가서).
    const w = icoBuf[off] || 256
    const h = icoBuf[off + 1] || 256
    found.push(`${w}x${h}`)
    if (w !== size || h !== size) continue
    const bytes = icoBuf.readUInt32LE(off + 8)
    const at = icoBuf.readUInt32LE(off + 12)
    const entry = icoBuf.subarray(at, at + bytes)
    if (!entry.subarray(0, 8).equals(PNG_SIGNATURE)) {
      // BMP 로 들어 있는 .ico 도 있다. 이 프로젝트의 아이콘은 전부 PNG 라
      // 디코더를 하나만 둔다 — 언젠가 BMP 원본이 들어오면 여기서 막힌다.
      throw new Error(`${size}x${size} 항목이 PNG 가 아니다(BMP 로 보인다). PNG 로 다시 내보낼 것`)
    }
    return entry
  }
  throw new Error(`${size}x${size} 항목이 없다. 들어 있는 크기: ${found.join(', ')}`)
}

/**
 * 최소 PNG 디코더. 8비트 RGBA(컬러 타입 6), 인터레이스 없음만 읽는다.
 * 필터는 다섯 종류를 모두 되돌린다 — 원본을 어떤 도구로 내보냈는지에 따라
 * 무엇이 쓰였는지 알 수 없고, 못 되돌리면 그림이 조용히 뭉개진다.
 */
function decodePng (png) {
  const idat = []
  let ihdr = null
  let off = PNG_SIGNATURE.length
  while (off < png.length) {
    const length = png.readUInt32BE(off)
    const type = png.subarray(off + 4, off + 8).toString('ascii')
    const data = png.subarray(off + 8, off + 8 + length)
    if (type === 'IHDR') ihdr = data
    else if (type === 'IDAT') idat.push(data)
    off += 12 + length
  }
  if (!ihdr) throw new Error('IHDR 이 없다')

  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  if (ihdr[8] !== 8) throw new Error(`비트 깊이가 8 이 아니다 (${ihdr[8]})`)
  if (ihdr[9] !== 6) throw new Error(`컬러 타입이 6(RGBA)이 아니다 (${ihdr[9]})`)
  if (ihdr[12] !== 0) throw new Error('인터레이스된 PNG 는 읽지 않는다')

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * 4
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`풀린 크기가 맞지 않는다: ${raw.length} != ${height * (stride + 1)}`)
  }

  // Paeth 예측자(PNG 명세 그대로).
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
  }

  const px = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      // a = 왼쪽 픽셀, b = 위 픽셀, c = 왼쪽 위 픽셀. 가장자리는 0 으로 친다.
      const a = i >= 4 ? px[y * stride + i - 4] : 0
      const b = y > 0 ? px[(y - 1) * stride + i] : 0
      const c = (i >= 4 && y > 0) ? px[(y - 1) * stride + i - 4] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      else if (filter !== 0) throw new Error(`${y}행의 필터 타입 ${filter} 을 모른다`)
      px[y * stride + i] = v & 0xff
    }
  }
  return { width, height, pixels: px }
}

/** 앱 아이콘에서 트레이용 32x32 RGBA 픽셀을 꺼낸다. */
function makePixels () {
  const decoded = decodePng(extractIcoPng(fs.readFileSync(SOURCE_ICON), W))
  if (decoded.width !== W || decoded.height !== H) {
    throw new Error(`${W}x${H} 를 기대했는데 ${decoded.width}x${decoded.height} 이 나왔다`)
  }
  return decoded.pixels
}

// --- 최소 PNG 인코더 ------------------------------------------------------

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

function chunk (type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(typeAndData.length + 8)
  out.writeUInt32BE(data.length, 0)
  typeAndData.copy(out, 4)
  out.writeUInt32BE(crc32(typeAndData), out.length - 4)
  return out
}

function encodePng (pixels, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type 6 = RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // 표준 필터
  ihdr[12] = 0 // 인터레이스 없음

  // 스캔라인마다 필터 바이트(0 = None)를 앞에 붙인다.
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 원본 .ico 에서 트레이용 PNG 바이트를 굽는다. main() 과 테스트가 같이 쓴다 —
 * 테스트가 이 함수를 다시 돌려 app/tray-icon.js 에 박힌 바이트와 견주므로,
 * 아이콘만 바꾸고 이 스크립트를 안 돌린 날이 그 자리에서 드러난다.
 */
function buildTrayIconPng () {
  return encodePng(makePixels(), W, H)
}

function main () {
  const png = buildTrayIconPng()
  const b64 = png.toString('base64')

  const source = `'use strict'
/**
 * 트레이 아이콘 (${W}x${H} RGBA PNG, base64).
 *
 * 이 파일은 생성물이다. 손으로 고치지 말고, 원본인 google-keep-electron.ico
 * (exe 아이콘과 같은 파일이다) 를 바꾼 뒤 다시 만들 것:
 *
 *   node scripts/make-tray-icon.js
 *
 * 왜 .png 파일이 아니라 소스 안의 문자열인가: 배포본은 app/ 전체가
 * app.asar 안으로 들어간다. asar 안의 경로는 이미지 로더가 읽지 못하는
 * 경우가 있고, 그러면 트레이 아이콘이 비어 아무것도 보이지 않는다. 창이
 * 하나도 없어도 앱이 살아 있어도 되는 유일한 근거가 "트레이에 아이콘이
 * 보인다"이므로, 그 근거가 포장 방식에 따라 사라지면 안 된다.
 *
 * Electron 을 require 하지 않는다 — 테스트에서 그대로 디코드해 검사한다.
 */
const TRAY_ICON_PNG_BASE64 =
  '${b64}'

const TRAY_ICON_DATA_URL = \`data:image/png;base64,\${TRAY_ICON_PNG_BASE64}\`

/** 원본 PNG 바이트. 검증(테스트)용이며 런타임 경로는 data URL 을 쓴다. */
function trayIconPngBuffer () {
  return Buffer.from(TRAY_ICON_PNG_BASE64, 'base64')
}

module.exports = { TRAY_ICON_PNG_BASE64, TRAY_ICON_DATA_URL, trayIconPngBuffer }
`
  fs.writeFileSync(OUT, source, 'utf8')
  console.log(`[tray-icon] 원본: ${path.relative(ROOT, SOURCE_ICON)} 의 ${W}x${H} 항목`)
  console.log(`[tray-icon] ${W}x${H} PNG ${png.length} bytes → base64 ${b64.length} chars`)
  console.log(`[tray-icon] 기록: ${path.relative(ROOT, OUT)}`)
}

// 직접 실행할 때만 파일을 쓴다. require 로 불러오는 쪽(테스트)은 굽기만 하고
// app/tray-icon.js 는 건드리지 않아야 한다 — 검사가 대상을 고쳐 버리면
// 무엇을 검사한 것인지 알 수 없다.
if (require.main === module) main()

module.exports = { buildTrayIconPng, extractIcoPng, decodePng, encodePng, W, H }
