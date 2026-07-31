'use strict'
document.getElementById('submit').addEventListener('click', async () => {
  const status = document.getElementById('status')
  const value = document.getElementById('email').value
  status.textContent = ''
  const res = await window.keepSticky.submitEmail(value)
  if (!res.ok) {
    status.textContent = res.message
    return
  }
  // 성공하면 main 프로세스가 이 창을 닫는다. 여기서 더 할 일이 없다.
})
