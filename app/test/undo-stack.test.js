'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  UNDO_STEP_LIMIT, createUndoStack, pushUndoState, undoStep, redoStep, canUndo, canRedo
} = require('../renderer/undo-stack')

test('갓 만든 기록은 되돌릴 것도 다시 할 것도 없다', () => {
  const stack = createUndoStack('처음')
  assert.strictEqual(canUndo(stack), false)
  assert.strictEqual(canRedo(stack), false)
  assert.strictEqual(undoStep(stack), null)
  assert.strictEqual(redoStep(stack), null)
})

test('한 번 밀어 넣고 되돌리면 처음 상태가 나온다', () => {
  const stack = createUndoStack('처음')
  pushUndoState(stack, '고침')
  assert.strictEqual(canUndo(stack), true)
  assert.strictEqual(undoStep(stack), '처음')
})

test('되돌린 뒤 다시 하면 같은 상태로 돌아온다', () => {
  const stack = createUndoStack('a')
  pushUndoState(stack, 'b')
  pushUndoState(stack, 'c')
  assert.strictEqual(undoStep(stack), 'b')
  assert.strictEqual(undoStep(stack), 'a')
  assert.strictEqual(redoStep(stack), 'b')
  assert.strictEqual(redoStep(stack), 'c')
  assert.strictEqual(canRedo(stack), false)
})

test('바닥에서 되돌리기, 꼭대기에서 다시 하기는 아무 일도 하지 않는다', () => {
  const stack = createUndoStack('a')
  pushUndoState(stack, 'b')
  assert.strictEqual(undoStep(stack), 'a')
  // 바닥이다. 몇 번을 더 눌러도 자리가 망가지지 않아야 한다.
  assert.strictEqual(undoStep(stack), null)
  assert.strictEqual(undoStep(stack), null)
  assert.strictEqual(redoStep(stack), 'b')
  assert.strictEqual(redoStep(stack), null)
  assert.strictEqual(redoStep(stack), null)
  // 그러고도 여전히 온전하다.
  assert.strictEqual(undoStep(stack), 'a')
})

test('되돌린 뒤 새 편집을 하면 다시 하기 가지가 사라진다', () => {
  const stack = createUndoStack('a')
  pushUndoState(stack, 'b')
  pushUndoState(stack, 'c')
  assert.strictEqual(undoStep(stack), 'b')
  pushUndoState(stack, '다른 길')
  assert.strictEqual(canRedo(stack), false, 'c 로 가는 길은 더 이상 없어야 한다')
  assert.strictEqual(undoStep(stack), 'b')
  assert.strictEqual(undoStep(stack), 'a')
})

// --- 묶기 --------------------------------------------------------------------

test('같은 열쇠로 이어 밀어 넣으면 한 단계로 묶인다', () => {
  const stack = createUndoStack('')
  pushUndoState(stack, '우', 'typing:0:1')
  pushUndoState(stack, '우유', 'typing:0:1')
  pushUndoState(stack, '우유 2', 'typing:0:1')
  // 세 글자를 쳤어도 되돌리기 한 번이면 치기 전으로 간다.
  assert.strictEqual(undoStep(stack), '')
  assert.strictEqual(canUndo(stack), false)
})

test('열쇠가 다르면 따로 쌓인다', () => {
  const stack = createUndoStack('')
  pushUndoState(stack, 'a', 'typing:0:1')
  pushUndoState(stack, 'ab', 'typing:0:1')
  pushUndoState(stack, 'ab/c', 'typing:1:1')   // 다른 줄로 옮겨 갔다
  assert.strictEqual(undoStep(stack), 'ab')
  assert.strictEqual(undoStep(stack), '')
})

test('열쇠가 없으면(체크 토글, 줄 지우기 같은 것) 언제나 새 단계다', () => {
  const stack = createUndoStack('')
  pushUndoState(stack, 'a', null)
  pushUndoState(stack, 'b', null)
  pushUndoState(stack, 'c', '')   // 빈 문자열도 "열쇠 없음"이다
  assert.strictEqual(undoStep(stack), 'b')
  assert.strictEqual(undoStep(stack), 'a')
  assert.strictEqual(undoStep(stack), '')
})

test('되돌린 직후의 편집은 방금 되돌아온 칸에 묶이지 않는다', () => {
  // 묶었다면 되돌아온 자리('ab')가 새 글자로 덮여 다시 갈 수 없게 된다.
  const stack = createUndoStack('')
  pushUndoState(stack, 'a', 'typing:0:1')
  pushUndoState(stack, 'ab', 'typing:0:1')
  pushUndoState(stack, 'ab!', null)
  assert.strictEqual(undoStep(stack), 'ab')
  pushUndoState(stack, 'abc', 'typing:0:1')  // 같은 열쇠로 이어 친다
  assert.strictEqual(undoStep(stack), 'ab', '되돌아왔던 자리가 남아 있어야 한다')
})

// --- 20 단계 상한 -------------------------------------------------------------

test('기본 상한은 20 단계다', () => {
  assert.strictEqual(UNDO_STEP_LIMIT, 20)
})

test('20 단계를 넘겨 밀어 넣으면 가장 오래된 것부터 버린다', () => {
  const stack = createUndoStack('s0')
  for (let n = 1; n <= 25; n += 1) pushUndoState(stack, `s${n}`)

  // 정확히 20 번 되돌릴 수 있고, 21 번째는 아무 일도 하지 않는다.
  const seen = []
  for (let n = 0; n < 20; n += 1) seen.push(undoStep(stack))
  assert.strictEqual(seen[0], 's24')
  assert.strictEqual(seen[19], 's5', '20 단계 전의 상태여야 한다')
  assert.strictEqual(undoStep(stack), null, '21 번째 되돌리기는 없다')
  // 버려진 것은 가장 오래된 쪽이다 — s0..s4 로는 갈 수 없다.
  assert.ok(!seen.includes('s0'))
  assert.ok(!seen.includes('s4'))
})

test('상한을 직접 정할 수 있고, 이상한 값은 기본값으로 떨어진다', () => {
  const small = createUndoStack('a', 2)
  pushUndoState(small, 'b')
  pushUndoState(small, 'c')
  pushUndoState(small, 'd')
  assert.strictEqual(undoStep(small), 'c')
  assert.strictEqual(undoStep(small), 'b')
  assert.strictEqual(undoStep(small), null)

  for (const bad of [0, -1, 1.5, '20', null, undefined]) {
    assert.strictEqual(createUndoStack('a', bad).limit, UNDO_STEP_LIMIT,
      `${JSON.stringify(bad)} 는 기본값으로 떨어져야 한다`)
  }
})

test('상한을 넘긴 뒤에도 다시 하기가 온전하다', () => {
  const stack = createUndoStack('s0', 3)
  for (let n = 1; n <= 6; n += 1) pushUndoState(stack, `s${n}`)
  assert.strictEqual(undoStep(stack), 's5')
  assert.strictEqual(undoStep(stack), 's4')
  assert.strictEqual(redoStep(stack), 's5')
  assert.strictEqual(redoStep(stack), 's6')
  assert.strictEqual(redoStep(stack), null)
})

test('상태 객체는 그대로 돌려준다 — 무엇이 담겼는지 이 모듈은 모른다', () => {
  const before = { lines: [{ kind: 'text', text: 'a' }], index: 0, caret: 1 }
  const after = { lines: [{ kind: 'item', text: 'a' }], index: 0, caret: 0 }
  const stack = createUndoStack(before)
  pushUndoState(stack, after, null)
  assert.strictEqual(undoStep(stack), before)
  assert.strictEqual(redoStep(stack), after)
})

test('망가진 기록을 넘겨도 죽지 않는다', () => {
  assert.strictEqual(canUndo(null), false)
  assert.strictEqual(canRedo(undefined), false)
  assert.strictEqual(undoStep(null), null)
  assert.strictEqual(redoStep(null), null)
  assert.strictEqual(pushUndoState(null, 'a'), null)
})

test('Electron 없이도 require 된다', () => {
  assert.strictEqual(typeof createUndoStack, 'function')
})
