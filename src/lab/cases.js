/**
 * Cases: the big tasks you hand out. Each is a board in the operations room with the workers on
 * it pinned up and strung together. Pure functions over the plain `state.cases` object, so the
 * rules run under node and the page only ever swaps in a new object (which is what lets the
 * colony file's merge tell what this tab changed).
 *
 * A case is bookkeeping in this world, like an archive: assigning one never writes to a harness.
 * "Brief" copies the case text and opens the worker's thread in its own agent, where you paste it.
 */

export const PRIORITY = ['routine', 'priority', 'urgent']
export const STATUS = ['open', 'active', 'closed']
export const PRIORITY_LABEL = { routine: 'Routine', priority: 'Priority', urgent: 'Urgent' }
export const STATUS_LABEL = { open: 'Open', active: 'Active', closed: 'Closed' }

let seq = 0
/** A short, unique, sortable id: creation time plus a counter. */
export function caseId(now = Date.now()) {
  return `case-${now.toString(36)}-${(seq++).toString(36)}`
}

/** A new case. Returns the next `cases` object; the input is never mutated. */
export function createCase(cases, { title, brief = '', priority = 'routine' }, now = Date.now()) {
  const clean = String(title || '').trim().slice(0, 120)
  if (!clean) throw new Error('A case needs a title')
  const id = caseId(now)
  return {
    cases: {
      ...cases,
      [id]: {
        id,
        title: clean,
        brief: String(brief || '').slice(0, 4000),
        priority: PRIORITY.includes(priority) ? priority : 'routine',
        status: 'open',
        assigned: [],
        createdAt: now,
        updatedAt: now,
      },
    },
    id,
  }
}

const touch = (c, now, patch) => ({ ...c, ...patch, updatedAt: now })

/** Put a worker on a case. Assigning the first worker moves an open case to active. */
export function assign(cases, caseId, threadId, now = Date.now()) {
  const c = cases[caseId]
  if (!c || c.assigned.includes(threadId)) return cases
  const status = c.status === 'open' ? 'active' : c.status
  return { ...cases, [caseId]: touch(c, now, { assigned: [...c.assigned, threadId], status }) }
}

export function unassign(cases, caseId, threadId, now = Date.now()) {
  const c = cases[caseId]
  if (!c || !c.assigned.includes(threadId)) return cases
  return { ...cases, [caseId]: touch(c, now, { assigned: c.assigned.filter((t) => t !== threadId) }) }
}

export function setStatus(cases, caseId, status, now = Date.now()) {
  const c = cases[caseId]
  if (!c || !STATUS.includes(status) || c.status === status) return cases
  return { ...cases, [caseId]: touch(c, now, { status }) }
}

export function setPriority(cases, caseId, priority, now = Date.now()) {
  const c = cases[caseId]
  if (!c || !PRIORITY.includes(priority) || c.priority === priority) return cases
  return { ...cases, [caseId]: touch(c, now, { priority }) }
}

export function edit(cases, caseId, { title, brief }, now = Date.now()) {
  const c = cases[caseId]
  if (!c) return cases
  const patch = {}
  if (title !== undefined) {
    const clean = String(title).trim().slice(0, 120)
    if (clean) patch.title = clean
  }
  if (brief !== undefined) patch.brief = String(brief).slice(0, 4000)
  return Object.keys(patch).length ? { ...cases, [caseId]: touch(c, now, patch) } : cases
}

export function removeCase(cases, caseId) {
  if (!cases[caseId]) return cases
  const next = { ...cases }
  delete next[caseId]
  return next
}

/** Cases a worker is on, open and active ones first. */
export function casesFor(cases, threadId) {
  return ordered(cases).filter((c) => c.assigned.includes(threadId))
}

/** Boards in the order they hang: open work first, urgent before routine, then oldest first. */
export function ordered(cases) {
  const rank = (c) => (c.status === 'closed' ? 2 : 0) * 10 + (2 - PRIORITY.indexOf(c.priority))
  return Object.values(cases || {}).sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
}

/** The text a worker is briefed with, ready to paste into their thread. */
export function briefText(c, workerTitle) {
  const lines = [`CASE: ${c.title}`, `Priority: ${PRIORITY_LABEL[c.priority]}`]
  if (workerTitle) lines.push(`Assigned to: ${workerTitle}`)
  lines.push('', c.brief || '(no brief written yet)')
  return lines.join('\n')
}

/** Example cases for the demo, marked as such, so the board is not empty on first look. */
export function demoCases(threadIds, now = Date.now()) {
  let cases = {}
  const make = (title, brief, priority, workers) => {
    const made = createCase(cases, { title: `Example: ${title}`, brief, priority }, now - workers.length * 1000)
    cases = made.cases
    for (const t of workers) cases = assign(cases, made.id, t, now)
  }
  make('Release 2.4 hardening', 'Close every crash reported against 2.4 before the release branch is cut.', 'urgent', threadIds.slice(0, 3))
  make('Migrate auth to the new provider', 'Swap the login flow onto the new identity provider without logging anyone out.', 'priority', threadIds.slice(3, 5))
  make('Docs sweep', 'Every public function has a doc comment and an example.', 'routine', threadIds.slice(5, 6))
  make('Quarterly dependency audit', 'List every dependency more than two majors behind, and why.', 'routine', [])
  return cases
}
