// Cada fixture es un transcript mínimo y anonimizado con la forma real de los registros de Claude Code.
// Un fixture por caso: tally cachea por ruta.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readTranscript, tally, derive } from '../transcript.mjs'

const fx = (name) => fileURLToPath(new URL(`./fixtures/${name}.jsonl`, import.meta.url))
const ms = (iso) => Date.parse(iso)
const registry = (over) => ({ sessionId: 'x', status: 'idle', startedAt: ms('2026-01-01T09:00:00Z'), statusUpdatedAt: 1, ...over })

test('pregunta pendiente, título, último prompt tecleado y ficheros relativos a la carpeta', () => {
  const t = readTranscript(fx('ask'), 'C:\\Workspace\\acme-shop')
  assert.equal(t.waitingQuestion, '¿Ascendente o descendente?')
  assert.equal(t.currentTool, null)
  assert.equal(t.title, 'Paginación del listado')
  assert.equal(t.lastPrompt.text, 'Y ordena por fecha') // no el task-notification posterior
  assert.equal(t.permissionMode, 'plan')
  assert.deepEqual([t.prompts, t.turns], [2, 3])
  assert.equal(t.lastAnswer.text, 'Hecho: paginación de 20 en 20.')
  assert.equal(t.lastTurnEndedAt, '2026-01-01T10:02:00.000Z')
  assert.equal(t.model, 'claude-opus-5-5') // el último mensaje del modelo
  assert.equal(t.contextTokens, 2220)
  assert.deepEqual(t.editedFiles, ['src\\orders\\list.tsx'])
  assert.equal(derive(registry({ status: 'busy' }), t).status, 'waiting')
})

test('tarea en background cuya notificación de fin ya llegó', () => {
  const t = readTranscript(fx('bg-notified'))
  assert.deepEqual(t.background, [])
  assert.equal(derive(registry(), t).status, 'idle')
})

test('tarea en background parada con TaskStop (por el id de tarea del resultado)', () => {
  const t = readTranscript(fx('bg-stopped'))
  assert.deepEqual(t.background, [])
})

test('tareas en background vivas: comando y agente, y la reanudación las descarta', () => {
  const t = readTranscript(fx('bg-running'))
  assert.deepEqual(t.background.map((b) => [b.tool, b.label]), [['Bash', 'pnpm test:e2e'], ['Agent', 'Revisar el diff']])
  const live = derive(registry(), t)
  assert.equal(live.status, 'background')
  assert.equal(live.agents, 1)
  // Proceso arrancado después de lanzarlas (sesión reanudada tras reiniciar): murieron con el proceso anterior.
  const resumed = derive(registry({ startedAt: ms('2026-01-01T11:00:00Z') }), t)
  assert.deepEqual(resumed.background, [])
  assert.equal(resumed.status, 'idle')
})

test('los subagentes (isSidechain) no cuentan como prompt, respuesta ni evento', () => {
  const t = readTranscript(fx('sidechain'))
  assert.equal(t.lastPrompt.text, 'Busca dónde se calcula el IVA')
  assert.equal(t.lastAnswer.text, 'El IVA se calcula en `src/tax.ts`.')
  const { total, events } = tally(fx('sidechain'))
  assert.equal(total, 125) // los tokens del subagente sí se pagan
  assert.deepEqual(events, [[ms('2026-01-01T10:00:00Z'), 'p'], [ms('2026-01-01T10:00:45Z'), 'e']])
})

test('tally: tokens y eventos incrementales, y la línea de tiempo empieza en el proceso actual', () => {
  const r = tally(fx('bg-notified'))
  assert.equal(r.total, 22)
  assert.deepEqual(r.events.map(([, k]) => k), ['p', 'e', 'e'])
  assert.equal(tally(fx('bg-notified')), r) // segunda llamada: nada nuevo que leer, mismo objeto
  const s = derive(registry({ startedAt: ms('2026-01-01T10:01:00Z') }), readTranscript(fx('bg-notified')), r)
  assert.equal(s.outputTokens, 22)
  assert.deepEqual(s.events, [[ms('2026-01-01T10:03:05Z'), 'e']])
})
