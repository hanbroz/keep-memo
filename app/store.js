'use strict'
const fs = require('node:fs')
const path = require('node:path')

// 포스트잇 기본 크기. Phase 1 에서는 고정이고, Phase 2 의 드래그 리사이즈가
// 같은 필드를 그대로 쓴다.
const DEFAULT_NOTE_STATE = { x: 120, y: 120, w: 320, h: 380, visible: false, conflictBackup: null }

class Store {
  constructor (filePath) {
    this.filePath = filePath
    this.data = { notes: {} }
  }

  load () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      this.data = { notes: parsed.notes || {} }
    } catch {
      // 파일이 없거나 손상됐다. 상태 파일 하나 때문에 앱이 못 뜨면 안 된다.
      this.data = { notes: {} }
    }
    return this.data
  }

  save () {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    // 임시 파일에 쓰고 원자적으로 교체한다. 쓰는 도중 죽어도 기존 파일이 남는다.
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }

  getNote (id) {
    return this.data.notes[id] || null
  }

  setNote (id, patch) {
    this.data.notes[id] = { ...DEFAULT_NOTE_STATE, ...(this.data.notes[id] || {}), ...patch }
    return this.data.notes[id]
  }

  visibleIds () {
    return Object.keys(this.data.notes).filter((id) => this.data.notes[id].visible)
  }
}

module.exports = { Store, DEFAULT_NOTE_STATE }
