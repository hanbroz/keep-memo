'use strict'
/**
 * 트레이 아이콘(app/tray-icon.js)을 다시 만든다.
 *
 *   node scripts/make-tray-icon.js
 *
 * 왜 이런 방식인가:
 *
 *  1. 이 앱은 네트워크에서 아이콘을 받아오지 않는다. 아이콘 하나 때문에
 *     오프라인에서 트레이가 비면 앱에 닿을 길이 사라진다. 그래서 픽셀을
 *     여기서 직접 그리고 PNG 로 인코딩한다 — 외부 이미지 라이브러리도,
 *     내려받는 에셋도 없다(node:zlib 만 쓴다).
 *  2. 결과물은 .png 파일이 아니라 base64 문자열을 담은 .js 모듈이다.
 *     배포본은 app/ 전체가 app.asar 로 묶이는데, asar 안의 경로를 이미지
 *     로더가 못 읽는 경우가 있다. 그러면 아이콘이 비고, "창이 없어도 앱이
 *     살아 있다"의 유일한 근거가 사라진다. 문자열은 asar 여부와 무관하다.
 *  3. 생성 코드를 저장소에 남겨 두는 이유: base64 덩어리만 있으면 아무도
 *     그 안에 뭐가 들었는지 확인하거나 고칠 수 없다.
 *
 * 그림은 단순하다 — 모서리가 둥근 노란 포스트잇에 글줄 세 개. 16px 로
 * 줄어들어도 "메모"로 읽히는 것이 유일한 목표다.
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'app', 'tray-icon.js')

// Windows 트레이는 논리 16x16 에 DPI 배율을 곱한 크기를 쓴다(125% → 20px,
// 150% → 24px, 200% → 32px). 32x32 하나만 두고 축소하게 하면 모든 배율을
// 덮는다.
const W = 32
const H = 32

const BORDER = [58, 46, 16, 255]   // 밝은 작업 표시줄에서도 형태가 남게 하는 진한 테두리
const BODY = [250, 213, 78, 255]   // 포스트잇 노랑
const LINE = [126, 101, 32, 255]   // 글줄

function makePixels () {
  const px = Buffer.alloc(W * H * 4, 0) // 기본값 0 = 완전 투명
  const set = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = (y * W + x) * 4
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
  }

  // 모서리가 둥근 사각형 안쪽인지. 모서리 반지름 r 의 중심으로 스냅한 뒤
  // 거리를 재는 방식이라 네 모서리를 따로 다루지 않아도 된다.
  const inRounded = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false
    const cx = x < x0 + r ? x0 + r : (x > x1 - r ? x1 - r : x)
    const cy = y < y0 + r ? y0 + r : (y > y1 - r ? y1 - r : y)
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= r * r
  }

  const x0 = 3, y0 = 3, x1 = 28, y1 = 28
  const t = 2 // 테두리 두께
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inRounded(x, y, x0, y0, x1, y1, 4)) continue
      const inside = inRounded(x, y, x0 + t, y0 + t, x1 - t, y1 - t, 2)
      set(x, y, inside ? BODY : BORDER)
    }
  }

  // 글줄 세 개. 32px 에서 2px 두께라 16px 로 줄어도 1px 로 남는다.
  const rows = [[11, 9, 22], [16, 9, 22], [21, 9, 18]]
  for (const [y, from, to] of rows) {
    for (let dy = 0; dy < 2; dy++) {
      for (let x = from; x <= to; x++) set(x, y + dy, LINE)
    }
  }
  return px
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

function main () {
  const png = encodePng(makePixels(), W, H)
  const b64 = png.toString('base64')

  const source = `'use strict'
/**
 * 트레이 아이콘 (${W}x${H} RGBA PNG, base64).
 *
 * 이 파일은 생성물이다. 손으로 고치지 말고 다시 만들 것:
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
  console.log(`[tray-icon] ${W}x${H} PNG ${png.length} bytes → base64 ${b64.length} chars`)
  console.log(`[tray-icon] 기록: ${path.relative(ROOT, OUT)}`)
}

main()
