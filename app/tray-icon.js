'use strict'
/**
 * 트레이 아이콘 (32x32 RGBA PNG, base64).
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
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACLElEQVR42mNgGAVo4P8Zi8x/x+Sf/T/M9///QXaq4H8Huf//3S/27O9elUz8lp/SXfn/ECfVLMbEHP//7JVdidPntLUc4YhfuxUwQ+LfUfln1LTo8DSB/96Oiv/bcyQw5P7sEX6GGQJUjHOQpfziWnAMcgxKmjjA9R/TATSyHJsDQJgmDsBmObYooIkDSLGcaAeADMBnCLmWE+UAULwRikdyLSfLAdgcQa7lJEUBLkdQYjlJiRCbRaAChhLLSc4F2BxBieVkZUNcjiDHcrLLAXRHkGs5RQURyFJQGsCVLWnuAGphoh3wbivX/wsL+P7/2svx/9hM/v8vN3H93zVR8P+GTuH/z9Zz/b+xjBfMPjxd4P/vfRz/T8/h+7+9T+j/8/Vc//8doIIDzs/n+18aL/1/Sqn4/4nF4mBLg90V/q9ohjigv0jif12qFNwBBTEy/3sKoNE0XYA6DrAxV/5fFi8NDoXnG7j+O1kr/c8Ml/1/aSEf2AEBropgx33fw/G/JE76/84Jgv9zo2Sp54CUYNn/0b7y/y8u4AM7IDFQ7v/dlTxgC0EOWN4k/P/tVk5wkINCACR2eSEfdaPgzFz+//H+cv9vLeeBhwAoLcBCoD5N8v+HbVxgtSA9JCdCUNOZXjng3z4OTAeA2u30csCfbVyYjVJQpwHUZKa5Aw5w/P+xigd7BwXUaaCpIw5w/P+5nnsl3t7Rr50KmaB2O6jpTM04/72V6xlOn49oAADQuLcoSC+RpAAAAABJRU5ErkJggg=='

const TRAY_ICON_DATA_URL = `data:image/png;base64,${TRAY_ICON_PNG_BASE64}`

/** 원본 PNG 바이트. 검증(테스트)용이며 런타임 경로는 data URL 을 쓴다. */
function trayIconPngBuffer () {
  return Buffer.from(TRAY_ICON_PNG_BASE64, 'base64')
}

module.exports = { TRAY_ICON_PNG_BASE64, TRAY_ICON_DATA_URL, trayIconPngBuffer }
