'use strict'

function render (notes) {
  const ul = document.getElementById('list')
  ul.textContent = ''
  for (const note of notes) {
    const li = document.createElement('li')

    const title = document.createElement('span')
    title.className = 'title'
    // textContent 를 쓴다. Keep 본문은 외부 데이터이므로 innerHTML 은 쓰지 않는다.
    title.textContent = note.title || note.text.split('\n')[0] || '(제목없음)'

    const date = document.createElement('span')
    date.className = 'date'
    date.textContent = note.updated.slice(0, 10)

    const open = document.createElement('button')
    open.textContent = '바탕화면에'
    open.addEventListener('click', () => window.keepSticky.openNote(note.id))

    li.append(title, date, open)
    ul.append(li)
  }
}

document.getElementById('new').addEventListener('click', async () => {
  const note = await window.keepSticky.createNote('', '')
  await window.keepSticky.openNote(note.id)
  render((await window.keepSticky.listNotes()).notes)
})

window.keepSticky.listNotes().then((res) => render(res.notes))
