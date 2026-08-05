'use strict'
// 내장 로그인(EmbeddedSetup)이 실패했을 때 뜨는 마지막 통로. 실제 교환과 검증은
// main 이 한다 — 이 창은 값을 넘기고 결과를 보여줄 뿐이다. 성공하면 main 이 이
// 창을 닫으므로 여기서 닫지 않는다(setup-email.js 와 같은 관례다).
const submit = document.getElementById('submit')

submit.addEventListener('click', async () => {
  const status = document.getElementById('status')
  const value = document.getElementById('token').value.trim()
  // main 이 같은 검사를 다시 한다. 여기 있는 것은 왕복을 기다리지 않고 곧바로
  // 알려주기 위한 것이다 — 렌더러는 신뢰 경계의 바깥쪽이라 이 검사만으로는
  // 검사가 아니다.
  if (!value.startsWith('oauth2_4/')) {
    status.textContent = 'oauth2_4/ 로 시작해야 합니다. 다른 쿠키를 복사했을 수 있습니다.'
    return
  }
  // 교환은 네트워크 왕복이다. 두 번 눌러 두 번 보내지 않게 잠근다 — 토큰은
  // 1회용이라 두 번째 요청은 반드시 실패하고, 그 실패 문구가 성공을 덮는다.
  submit.disabled = true
  status.textContent = '교환 중...'
  try {
    const res = await window.keepSticky.submitManualToken(value)
    // 성공하면 main 이 창을 닫는다. 그때까지 잠깐 보이는 문구다.
    status.textContent = res.ok ? '연결됨' : `실패: ${res.message}`
  } catch (err) {
    // 창이 닫히는 중이면 핸들러가 이미 사라져 거절될 수 있다. 조용히 끝내지 않는다.
    status.textContent = `실패: ${err && err.message ? err.message : err}`
  } finally {
    // 실패했으면 다시 시도할 수 있어야 한다. 토큰이 만료됐을 뿐인 경우가 가장
    // 흔하고, 그때는 아래 5번을 다시 해서 새 값을 붙여넣으면 된다.
    submit.disabled = false
  }
})
