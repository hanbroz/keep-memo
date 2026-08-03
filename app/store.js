'use strict'
const fs = require('node:fs')
const path = require('node:path')
// 서체 설정의 기본값과 검증은 렌더러와 한 벌만 있어야 한다. 창마다 따로 판단하면
// state.json 에 든 값과 화면에 보이는 값이 언젠가 갈라진다. 이 모듈은 Electron
// 을 건드리지 않는 순수 함수뿐이라 main 프로세스에서 그대로 require 된다
// (위치가 renderer/ 인 이유는 그 파일의 주석에 있다 — list.html 이 <script src>
// 로도 같은 파일을 부른다).
const { normalizeFontSettings } = require('./renderer/font-settings')
// 노트별 서체 재정의의 검증도 한 벌만 있어야 한다. 이유는 위와 같다.
const { normalizeNoteFontOverride } = require('./renderer/note-font')

// 포스트잇 기본 크기. Phase 1 에서는 고정이고, Phase 2 의 드래그 리사이즈가
// 같은 필드를 그대로 쓴다.
//
// x / y / w / h 는 **펼쳐진 상태의 기하**만 담는다. 접힌 책갈피의 좌표는 이
// 파일에 절대 들어오지 않는다 — 들어오는 순간 펼칠 자리를 잃는다. folded 는
// visible 과 나란히 놓인다: visible 은 "바탕화면에 있는가", folded 는 "그
// 바탕화면 위에서 책갈피로 접혀 있는가"다. 접힌 메모도 바탕화면에 있으므로
// visible 은 여전히 true 이고, 목록 창에서도 체크된 상태로 보인다.
//
// font 는 이 노트만의 서체 재정의다. null 이 "재정의 없음"이고, 그때 이 노트는
// 전역 서체 설정(this.data.fonts)을 그대로 따른다. Keep 에는 서체 필드가 없어
// 이 값은 이 PC 에서만 산다 — 그래서 전역 설정처럼 최상위가 아니라 노트 항목
// 안에 있다.
const DEFAULT_NOTE_STATE = {
  x: 120, y: 120, w: 320, h: 380, visible: false, folded: false, conflictBackup: null, font: null
}

class Store {
  constructor (filePath) {
    this.filePath = filePath
    this.data = { notes: {}, email: null, fonts: null }
  }

  load () {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      // fonts 는 null 로 둔다 — "저장한 적 없음"과 "저장했는데 비었음"을 구별할
      // 이유가 없고, getFontSettings() 가 어느 쪽이든 기본값으로 채워 준다.
      this.data = { notes: parsed.notes || {}, email: parsed.email || null, fonts: parsed.fonts || null }
    } catch (err) {
      // 파일이 아예 없는 것(ENOENT)은 첫 실행이므로 조용히 넘어간다.
      // 그 외(손상된 JSON, 권한 오류, 백신의 파일 잠금 등)는 진짜 환경
      // 문제일 수 있으므로 경고를 남긴다 — 단, 에러 코드와 경로만 남기고
      // 파일 내용은 절대 로그에 남기지 않는다. 어느 경우든 상태 파일
      // 하나 때문에 앱이 못 뜨면 안 되므로 빈 상태로 폴백한다.
      if (err.code !== 'ENOENT') {
        console.warn(`상태 파일을 읽지 못했다 (${err.code}): ${this.filePath}`)
      }
      this.data = { notes: {}, email: null, fonts: null }
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

  /**
   * 노트 하나의 상태를 통째로 잊는다. **휴지통으로 보낸 뒤에만 부른다.**
   *
   * 지우는 것이 맞다. 남겨두면 두 가지가 무기한 남는다: 존재하지 않는 메모의
   * 좌표/크기/서체와, 저장에 실패했던 편집본(conflictBackup)이다. 두 번째가
   * 특히 나쁘다 — 사용자가 지운 메모의 본문이 %APPDATA% 의 state.json 에
   * 평문으로 남아 있고, 그것을 보거나 지울 UI 는 없다.
   *
   * 되돌리기와도 어긋나지 않는다. trash 는 Keep 휴지통으로 보내는 것이라
   * 7일 안에 Keep 에서 복구할 수 있는데, 복구된 메모는 다음 목록 새로고침에서
   * 처음 보는 메모처럼 기본 위치로 다시 잡히면 된다.
   */
  forgetNote (id) {
    const existed = Object.prototype.hasOwnProperty.call(this.data.notes, id)
    delete this.data.notes[id]
    return existed
  }

  visibleIds () {
    return Object.keys(this.data.notes).filter((id) => this.data.notes[id].visible)
  }

  // 노트별 서체 재정의. 전역 설정(getFontSettings)과 달리 "없음"이 정상 상태다 —
  // null 이면 그 노트는 전역을 따른다. 읽을 때도 쓸 때도 같은 정규화를 지나므로
  // 손으로 고쳐 넣은 이상한 값이 화면까지 오지 않고, 파일에도 남지 않는다.
  getNoteFont (id) {
    const note = this.data.notes[id]
    return normalizeNoteFontOverride(note && note.font)
  }

  /** 저장한(=검증을 지난) 값을 그대로 돌려준다. 재정의가 하나도 없으면 null. */
  setNoteFont (id, raw) {
    const value = normalizeNoteFontOverride(raw)
    this.setNote(id, { font: value })
    return value
  }

  // Keep 계정 이메일. state.json 에 저장되는 유일한 개인정보 — 마스터 토큰은
  // 절대 여기 오지 않는다(OS 자격 증명 저장소에만 있다).
  getEmail () {
    return this.data.email || null
  }

  setEmail (email) {
    this.data.email = email
  }

  // 서체 설정(글꼴 / 제목 크기 / 본문 크기). email 과 같은 자리(state.json 의
  // 최상위)에 산다. 개인정보가 아니고 노트별 값도 아니므로 notes 안에 넣지
  // 않는다.
  //
  // 읽을 때도 쓸 때도 normalizeFontSettings 를 지난다. 그래서
  //  - 저장한 적이 없으면(null) 기본값이 나오고,
  //  - 사람이 state.json 을 손으로 고쳐 이상한 값을 넣어도 화면까지 오지 않으며,
  //  - 파일에는 언제나 검증을 지난 값만 남는다.
  getFontSettings () {
    return normalizeFontSettings(this.data.fonts)
  }

  /** 저장한(=검증을 지난) 값을 그대로 돌려준다. 부르는 쪽이 화면에 그대로 쓴다. */
  setFontSettings (raw) {
    this.data.fonts = normalizeFontSettings(raw)
    return this.data.fonts
  }
}

module.exports = { Store, DEFAULT_NOTE_STATE }
