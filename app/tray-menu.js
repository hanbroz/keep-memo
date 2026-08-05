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
 * [다시 로그인]이 여기 있는 이유: 저장된 자격증명이 구글에서 무효가 되면 목록
 * 창의 [동기화]도 실패한다. 그 창에서만 다시 로그인할 수 있게 하면, 창을 닫아
 * 둔 사용자는 앱을 껐다 켜도(auth_status 가 토큰의 존재만 보므로 로그인 창이
 * 뜨지 않는다) 빠져나올 길이 없다. 트레이는 언제나 거기 있다.
 *
 * [업데이트 확인]도 여기 둔다. 시작할 때의 확인은 새 버전이 있을 때만 말하므로,
 * "지금이 최신인가"를 사용자가 직접 물어볼 통로가 따로 있어야 한다.
 *
 * [윈도우 시작할 때 실행]은 **끄는 길**로서 여기 있다. 기본값이 켜짐이라
 * (auto-launch.js) 사용자가 부탁한 적 없이 시작 프로그램에 들어가는 셈인데,
 * 그것을 되돌릴 방법이 화면 어디에도 없으면 안 된다. 목록 창이 아니라 트레이에
 * 두는 이유는 [다시 로그인]과 같다 — 목록 창은 닫아 둘 수 있고 트레이는 언제나
 * 거기 있다. 체크 상태는 부르는 쪽이 state.json 에서 읽어 넘긴다.
 *
 * @param {{onOpenList: Function, onRelogin: Function, onCheckUpdate: Function,
 *          onToggleAutoLaunch: Function, onQuit: Function,
 *          autoLaunchEnabled?: boolean}} actions
 * @returns {Array<object>} Menu.buildFromTemplate 에 그대로 넘길 배열
 */
function trayMenuTemplate ({
  onOpenList, onRelogin, onCheckUpdate, onToggleAutoLaunch, onQuit, autoLaunchEnabled = false
}) {
  if (typeof onOpenList !== 'function' || typeof onRelogin !== 'function' ||
      typeof onCheckUpdate !== 'function' || typeof onToggleAutoLaunch !== 'function' ||
      typeof onQuit !== 'function') {
    // 핸들러가 빠진 메뉴는 눌러도 아무 일이 없다. 트레이가 앱에 닿는 유일한
    // 길이므로, 조용히 죽은 메뉴를 만드느니 만들 때 터지는 편이 낫다.
    throw new TypeError(
      '트레이 메뉴에는 onOpenList, onRelogin, onCheckUpdate, onToggleAutoLaunch, onQuit 이 모두 필요하다')
  }
  return [
    { label: '메모 목록 열기', click: onOpenList },
    { type: 'separator' },
    { label: '다시 로그인', click: onRelogin },
    { label: '업데이트 확인', click: onCheckUpdate },
    // type: 'checkbox' 는 Electron 이 눌릴 때 checked 를 알아서 뒤집는다. 부르는
    // 쪽은 그 뜻을 state.json 에 옮기기만 하면 되므로 두 곳이 어긋나지 않는다.
    {
      label: '윈도우 시작할 때 실행',
      type: 'checkbox',
      checked: !!autoLaunchEnabled,
      click: onToggleAutoLaunch
    },
    { type: 'separator' },
    { label: '종료', click: onQuit }
  ]
}

module.exports = { trayMenuTemplate, TRAY_TOOLTIP }
