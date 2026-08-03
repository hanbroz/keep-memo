'use strict'
/**
 * 트레이 아이콘 (32x32 RGBA PNG, base64).
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
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAX0lEQVR42mNgGAWDGVjpCfynBh4wi8lyCLKGX1f9qIJJcgS1LUd3xIBYTrQjRh0waB1Ql6pAFh4+DhhNA6OJcDQRjjqA3DgfPg4YOWlgwJtkg6JROuDN8kHRMRkF9AQA8HRkN7jXSE8AAAAASUVORK5CYII='

const TRAY_ICON_DATA_URL = `data:image/png;base64,${TRAY_ICON_PNG_BASE64}`

/** 원본 PNG 바이트. 검증(테스트)용이며 런타임 경로는 data URL 을 쓴다. */
function trayIconPngBuffer () {
  return Buffer.from(TRAY_ICON_PNG_BASE64, 'base64')
}

module.exports = { TRAY_ICON_PNG_BASE64, TRAY_ICON_DATA_URL, trayIconPngBuffer }
