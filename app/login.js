'use strict'

const SETUP_URL = 'https://accounts.google.com/EmbeddedSetup'
const COOKIE_NAME = 'oauth_token'
const COOKIE_PREFIX = 'oauth2_4/'

/**
 * EmbeddedSetup 창의 세션에서 oauth_token 쿠키를 감시한다.
 *
 * 이 흐름은 "시스템 브라우저로 열기" 회피책을 쓸 수 없다. 일반 OAuth 는 콜백
 * URL 로 결과가 돌아오지만 EmbeddedSetup 은 리다이렉트가 없고 결과가 쿠키로만
 * 남는다. 사용자의 크롬에 심긴 쿠키를 우리가 읽을 방법은 없으므로 반드시
 * 우리가 띄운 창이어야 한다.
 *
 * 얻은 토큰은 1회용이고 약 60초 만에 만료된다. 호출자는 즉시 교환해야 한다.
 */
async function pollCookie (session, { intervalMs = 500, timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const cookies = await session.cookies.get({ name: COOKIE_NAME })
    const hit = cookies.find((c) => c.value && c.value.startsWith(COOKIE_PREFIX))
    if (hit) return hit.value
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

function createLoginWindow (BrowserWindow) {
  const win = new BrowserWindow({
    width: 520,
    height: 680,
    title: 'Google 계정 연결',
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:login' }
  })
  win.loadURL(SETUP_URL)
  return win
}

module.exports = { pollCookie, createLoginWindow, SETUP_URL, COOKIE_NAME, COOKIE_PREFIX }
