'use strict'
document.getElementById('submit').addEventListener('click', async () => {
  const status = document.getElementById('status')
  const value = document.getElementById('token').value.trim()
  if (!value.startsWith('oauth2_4/')) {
    status.textContent = 'oauth2_4/ 로 시작해야 합니다. 다른 쿠키를 복사했을 수 있습니다.'
    return
  }
  status.textContent = '교환 중...'
  const res = await window.keepSticky.exchangeCookie(value)
  status.textContent = res.ok ? '연결됨' : `실패: ${res.message}`
})
