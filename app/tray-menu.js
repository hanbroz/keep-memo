'use strict'

/** 트레이 아이콘에 마우스를 올렸을 때 뜨는 이름. 목록 창 제목과 같게 둔다. */
const TRAY_TOOLTIP = 'Keep 메모'

/**
 * 트레이 컨텍스트 메뉴의 템플릿을 만든다. Electron 을 require 하지 않는 순수
 * 함수라 테스트에서 그대로 검사할 수 있다 — 메뉴에 무엇이 있고 무엇이 없는지가
 * 이 앱에서는 안전 문제이기 때문이다.
 *
 * 메뉴에 절대 넣지 않는 것: 메모 삭제. 삭제는 포스트잇 우클릭 → 확인 대화상자
 * 경로 하나뿐이다. 트레이 메뉴는 손이 미끄러지기 쉬운 곳이고, 여기서 한 번의
 * 클릭으로 Keep 메모가 사라지는 길을 열어서는 안 된다.
 *
 * [종료]가 부르는 onQuit 은 반드시 app.quit() 이어야 한다. 사이드카(마스터
 * 토큰을 쥔 파이썬 자식)를 죽이고 포스트잇의 미저장 편집을 저장하는 정리는
 * 전부 before-quit / will-quit 핸들러에 있다. 트레이가 그 경로를 건너뛰고
 * 직접 프로세스를 끝내면 편집이 소리 없이 사라진다.
 *
 * @param {{onOpenList: Function, onQuit: Function}} actions
 * @returns {Array<object>} Menu.buildFromTemplate 에 그대로 넘길 배열
 */
function trayMenuTemplate ({ onOpenList, onQuit }) {
  if (typeof onOpenList !== 'function' || typeof onQuit !== 'function') {
    // 핸들러가 빠진 메뉴는 눌러도 아무 일이 없다. 트레이가 앱에 닿는 유일한
    // 길이므로, 조용히 죽은 메뉴를 만드느니 만들 때 터지는 편이 낫다.
    throw new TypeError('트레이 메뉴에는 onOpenList 와 onQuit 이 모두 필요하다')
  }
  return [
    { label: '메모 목록 열기', click: onOpenList },
    { type: 'separator' },
    { label: '종료', click: onQuit }
  ]
}

module.exports = { trayMenuTemplate, TRAY_TOOLTIP }
