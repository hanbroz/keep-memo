'use strict'

// 되돌리기 / 다시 하기 기록. 순수한 자료구조라서 화면도 DOM 도 모른다 —
// 무엇을 담는지(줄 배열인지 문자열인지)조차 모른다. 담긴 값을 그대로 돌려줄 뿐이다.
//
// 위치가 app/renderer/ 인 이유는 line-model.js / url-open.js 와 같다.
//
// --- 왜 직접 들고 있는가 ---------------------------------------------------
//
// <textarea> 의 기본 되돌리기는 코드가 .value 에 한 번이라도 대입하는 순간
// 통째로 무효가 된다. 이 편집기는 줄을 끊고 붙이고 표식을 붙였다 떼며 값을
// 쉴 새 없이 다시 쓰므로, 기본 기록에 기댈 수 있는 길이 애초에 없다.
// 그래서 기록의 주인이 우리다. **줄 모형 위에** 들고 있는 것이 핵심이다 —
// 텍스트 두 벌을 비교해 차이를 뽑는 방식보다 단순하고, 캐럿 자리까지 같이
// 되돌릴 수 있다.
//
// --- 자료구조 ---------------------------------------------------------------
//
// entries 는 **지금 상태를 포함한** 스냅샷 줄이고, index 가 그중 지금을 가리킨다.
//
//   entries: [처음, 편집1, 편집2, 편집3]
//   index:                        ^ 3
//
// 되돌리기는 index 를 하나 내리고 그 자리의 상태를 돌려준다. 다시 하기는 하나
// 올린다. 그래서 "되돌릴 수 있는 단계 수" = index 이고, 칸 수는 언제나
// limit + 1 까지다(지금 상태가 한 칸을 쓴다).
//
// 새 편집은 **다시 하기 가지를 잘라낸다.** 되돌린 뒤 다른 길로 가면 원래 가지는
// 더 이상 닿을 수 없다 — 모든 편집기가 그렇게 동작하고, 그러지 않으면 "다시
// 하기"가 사용자가 쓴 적 없는 내용을 되살린다.
//
// --- 묶기(coalesce) --------------------------------------------------------
//
// 글자 하나마다 한 단계씩 쌓으면 Ctrl+Z 스무 번이 낱말 하나를 지운다. 그래서
// 부르는 쪽이 **묶음 열쇠**를 같이 넘긴다: 맨 위 칸의 열쇠와 같은 열쇠로 밀어
// 넣으면 새 칸을 만들지 않고 맨 위를 갱신한다.
//
// 시계는 일부러 여기 없다. "몇 밀리초 안이면 같은 묶음"은 부르는 쪽(note.js)이
// 열쇠 문자열에 담아 오고, 이 모듈은 그 열쇠가 같은지만 본다 — 그래야 테스트가
// 시간에 기대지 않는다.
//
// 되돌린 직후에는 절대 묶지 않는다(sealed). 방금 되돌아온 그 상태 위에
// 이어 치는 글자가 그 칸을 덮어써 버리면, 되돌린 자리로 다시 갈 수 없다.

const UNDO_STEP_LIMIT = 20

/**
 * 기록을 만든다. 첫 칸은 지금(=불러온 직후) 상태다.
 *
 * @param {unknown} initialState
 * @param {number} [limit] 되돌릴 수 있는 **단계** 수. 기본 20.
 */
function createUndoStack (initialState, limit) {
  const steps = Number.isInteger(limit) && limit > 0 ? limit : UNDO_STEP_LIMIT
  return { entries: [{ state: initialState, key: null }], index: 0, limit: steps, sealed: false }
}

function canUndo (stack) {
  return !!stack && stack.index > 0
}

function canRedo (stack) {
  return !!stack && stack.index < stack.entries.length - 1
}

/**
 * 편집이 끝난 **뒤의** 상태를 밀어 넣는다.
 *
 * @param {object} stack
 * @param {unknown} state
 * @param {string|null} [coalesceKey] 맨 위 칸과 같은 열쇠면 새 칸을 만들지 않는다.
 *                                    null/빈 문자열이면 언제나 새 칸이다.
 * @returns {object} 같은 stack
 */
function pushUndoState (stack, state, coalesceKey) {
  if (!stack) return stack
  const key = typeof coalesceKey === 'string' && coalesceKey !== '' ? coalesceKey : null

  // 새 편집은 다시 하기 가지를 잘라낸다.
  stack.entries.length = stack.index + 1

  const top = stack.entries[stack.index]
  if (key !== null && !stack.sealed && top && top.key === key) {
    top.state = state
    stack.sealed = false
    return stack
  }

  stack.entries.push({ state, key })
  stack.index = stack.entries.length - 1
  stack.sealed = false

  // 칸 수는 "지금 + 되돌릴 수 있는 단계"이므로 limit + 1 이다. 넘치면 가장
  // 오래된 것부터 버린다 — 오래된 쪽을 버려야 방금 한 일을 되돌릴 수 있다.
  const capacity = stack.limit + 1
  if (stack.entries.length > capacity) {
    stack.entries.splice(0, stack.entries.length - capacity)
    stack.index = stack.entries.length - 1
  }
  return stack
}

/**
 * 한 단계 되돌린다. 더 되돌릴 것이 없으면 아무것도 하지 않고 null 을 돌려준다.
 * @returns {unknown|null} 돌아간 자리의 상태
 */
function undoStep (stack) {
  if (!canUndo(stack)) return null
  stack.index -= 1
  stack.sealed = true
  return stack.entries[stack.index].state
}

/**
 * 한 단계 다시 한다. 더 갈 곳이 없으면 아무것도 하지 않고 null 을 돌려준다.
 * @returns {unknown|null}
 */
function redoStep (stack) {
  if (!canRedo(stack)) return null
  stack.index += 1
  stack.sealed = true
  return stack.entries[stack.index].state
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    UNDO_STEP_LIMIT,
    createUndoStack,
    pushUndoState,
    undoStep,
    redoStep,
    canUndo,
    canRedo
  }
}
