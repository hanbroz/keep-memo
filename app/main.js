'use strict'
const { app, BrowserWindow, session } = require('electron')
const { createLoginWindow, pollCookie } = require('./login')

app.whenReady().then(async () => {
  const win = createLoginWindow(BrowserWindow)
  const value = await pollCookie(session.fromPartition('persist:login'),
                                 { intervalMs: 1000, timeoutMs: 300000 })
  console.log(value ? `쿠키 획득: ${value.slice(0, 16)}...` : '쿠키 획득 실패')
  win.close()
})
