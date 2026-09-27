import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, expect, test } from 'bun:test'

import { openDb } from '../src/db.ts'
import { actualizarActa, admitir, cerrado, elegirRevisores, ensayo, leerVeredicto, parsearVeredicto } from '../src/ensayo.ts'
import { proceso } from '../src/process.ts'

import type { Validacion } from '../src/actores.ts'
import type { Veredicto } from '../src/ensayo.ts'

const dir = mkdtempSync(join(tmpdir(), 'reparto-ensayo-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('el lector guardado conserva objeciones, notas y cierres sin recortar', () => {
  // Given: una revisión con campos opcionales y un texto mayor que el tope de bitácora.
  const revision: Veredicto = {
    veredicto: 'OBJECIONES',
    objeciones: [{ seccion: 'T1', defecto: 'x'.repeat(32_001), causa: 'c', cierre: 'f', justificacion: 'de la ronda 1' }],
    notas: ['', 'nota'],
    cierres: { 1: 'cerrado', 2: 'abierto' },
  }

  // When: se relee el JSON persistido; Then: todos los campos conservan su valor.
  expect(leerVeredicto(JSON.stringify(revision))).toEqual(revision)
})

test('OBJECIONES sin objeciones nuevas es válido si sigue pendiente el acta', () => {
  // Given: admitir puede guardar esta revisión cuando no se cierra una objeción anterior.
  const revision: Veredicto = { veredicto: 'OBJECIONES', objeciones: [], notas: [], cierres: { 1: 'abierto' } }

  // When: se relee; Then: no se exige una objeción nueva para una ronda de cierre.
  expect(leerVeredicto(JSON.stringify(revision))).toEqual(revision)
})

test('ensayo rechaza la aprobación guardada corrupta antes de cerrar o relanzar revisores', async () => {
  // Given: dos aprobaciones aparentes del hash actual, una de ellas sin notas ni cierres.
  const location = join(dir, 'guardado-corrupto')
  const plan = '.reparto/planes/demo.md'
  const contenido = '### T1: comprobar\n'

  mkdirSync(join(location, '.reparto/planes'), { recursive: true })
  writeFileSync(join(location, plan), contenido)
  using database = openDb(':memory:')
  const previo = proceso.db

  proceso.db = database

  try {
    for (const revisor of ['critico', 'oracle']) {
      database
        .query('INSERT INTO ensayos VALUES (?, 1, ?, ?, ?, ?)')
        .run(
          join(location, plan),
          createHash('sha256').update(contenido).digest('hex'),
          revisor,
          'p/m',
          JSON.stringify(
            revisor === 'critico' ? { veredicto: 'APROBADO', objeciones: [] } : parsearVeredicto('VEREDICTO: APROBADO'),
          ),
        )
    }

    const ejecutar = ensayo(
      { session: { get: async () => ({ agent: 'dramaturgo', location: { directory: location } }) } },
      {
        delegar: async () => {
          throw new Error('no debe relanzar un ensayo corrupto')
        },
      },
    )

    // When: se reensaya; Then: el mismo lector impide anunciar el cierre de una revisión corrupta.
    await expect(ejecutar({ plan }, { sessionID: 'ses_padre', signal: new AbortController().signal })).rejects.toThrow(
      /veredicto guardado: notas/,
    )
  } finally {
    proceso.db = previo
  }
})

test('parses approved, section-level objections and closure lines', () => {
  // Given: verdicts in the reviewers' wire format.
  const aprobado = 'VEREDICTO: APROBADO\nACTA: 1 | cerrado\nNOTA: optional polish'
  const objetado =
    'VEREDICTO: OBJECIONES\nOBJECION: Tasks/T1 | no verification command | outcome not checked | add runnable check'

  // When: the lines are parsed; Then: their semantic fields survive.
  expect(parsearVeredicto(aprobado)).toEqual({
    veredicto: 'APROBADO',
    objeciones: [],
    cierres: { 1: 'cerrado' },
    notas: ['optional polish'],
  })
  expect(parsearVeredicto(objetado).objeciones).toEqual([
    { seccion: 'Tasks/T1', defecto: 'no verification command', causa: 'outcome not checked', cierre: 'add runnable check' },
  ])
})

test('malformed objection or acta fails the review rather than approving', () => {
  // Given: an objection verdict with no parseable objection, or a malformed acta line.
  // When: parsing the reviewer output; Then: neither can become an approval.
  expect(() => parsearVeredicto('VEREDICTO: OBJECIONES\nOBJECION: T1 | incomplete')).toThrow(/inválido/)
  expect(() => parsearVeredicto('VEREDICTO: OBJECIONES\nNOTA: no objections')).toThrow(/sin objeción/)
  expect(() => parsearVeredicto('VEREDICTO: APROBADO\nACTA: nonsense')).toThrow(/inválido/)
})

test('a malformed reviewer leaves the round pending and relaunches fresh encargos', async () => {
  // Given: one malformed review in a first round and valid reviews on retry.
  const location = join(dir, 'retry')

  mkdirSync(join(location, '.reparto/planes'), { recursive: true })
  writeFileSync(join(location, '.reparto/planes/demo.md'), '### T1: check\n')
  const database = openDb(join(dir, 'retry.db'))
  const previous = { db: proceso.db, validacion: proceso.validacion }

  proceso.db = database
  proceso.validacion = {
    actores: new Map([
      ['critico', [{ model: 'kimi-code-plan-global/k3' }]],
      ['oracle', [{ model: 'claude-code/haiku' }]],
    ]),
    exclusiones: [],
    desactivados: [],
    desconocidos: [],
  }
  let launched = 0
  const ctx = { session: { get: async () => ({ agent: 'dramaturgo', location: { directory: location } }) } }
  const dispatch = {
    delegar: async () => {
      const hija = `ses_retry_${++launched}`

      database
        .query(`INSERT INTO encargos (hija, padre, a, actor, background, estado, mensaje_final, boot_id, pid, starttime, creado)
      VALUES (?, 'parent', 'critico', 'p/m', 0, 'terminado', ?, 'b', 1, '1', 0)`)
        .run(hija, launched === 1 ? 'VEREDICTO: OBJECIONES\nOBJECION: malformed' : 'VEREDICTO: APROBADO')

      return hija
    },
  }
  const run = ensayo(ctx, dispatch as Parameters<typeof ensayo>[1])
  const tool = { sessionID: 'parent' } as Parameters<ReturnType<typeof ensayo>>[1]

  try {
    // When: the malformed review fails; Then: the round stays pending, not approved.
    await expect(run({ plan: '.reparto/planes/demo.md' }, tool)).rejects.toThrow(/ronda 1 incompleta/)
    expect(database.query('SELECT DISTINCT veredicto FROM ensayos').all()).toEqual([{ veredicto: 'pendiente' }])
    // When: retried; Then: both reviewers get new encargos and can close the round.
    const acta = await run({ plan: '.reparto/planes/demo.md' }, tool)

    expect(JSON.parse(acta.content).cerrado).toBe(true)
    expect(launched).toBe(4)
  } finally {
    proceso.db = previous.db
    proceso.validacion = previous.validacion
    database.close()
  }
})

test('selects distinct available providers, or marks repeated providers after bajas', () => {
  // Given: the dramaturgo uses openai, and oracle has one alternate provider.
  const validacion: Validacion = {
    actores: new Map([
      ['critico', [{ model: 'openai/cheap' }, { model: 'kimi-code-plan-global/cheap' }]],
      ['oracle', [{ model: 'openai/other' }, { model: 'opencode-go/cheap' }]],
    ]),
    exclusiones: [],
    desactivados: [],
    desconocidos: [],
  }

  // When: all actors are available; Then: neither reviewer shares the dramaturgo's provider.
  expect(elegirRevisores(validacion, 'openai', () => false)).toEqual({
    critico: { model: 'kimi-code-plan-global/cheap' },
    oracle: { model: 'opencode-go/cheap' },
    repetidos: false,
  })
  // Even if one reviewer must share the dramaturgo's provider, keep the reviewers distinct.
  expect(elegirRevisores(validacion, 'openai', (actor) => actor.model.startsWith('kimi-code-plan-global/'))).toEqual({
    critico: { model: 'openai/cheap' },
    oracle: { model: 'opencode-go/cheap' },
    repetidos: true,
  })
  // When: both alternate providers are down; Then: the round still runs, explicitly marked.
  expect(elegirRevisores(validacion, 'openai', (actor) => !actor.model.startsWith('openai/'))?.repetidos).toBe(true)
  expect(elegirRevisores(validacion, 'openai', () => true)).toBeUndefined()
})

test('round-one objections form acta; unjustified new objection stays a note and cannot reopen it', () => {
  const db = openDb(join(dir, 'acta.db'))
  const first = parsearVeredicto('VEREDICTO: OBJECIONES\nOBJECION: T1 | missing verification | unchecked result | add bun test')
  const approved = parsearVeredicto('VEREDICTO: APROBADO')
  // Given: one accepted objection from discovery; When: the acta is formed.
  const initial = db.transaction(() => actualizarActa(db, 'plan.md', 1, [first, approved]))()

  // Then: it has an open condition and origin.
  expect(initial).toMatchObject([
    {
      objecion: 'T1: missing verification',
      causa: 'unchecked result',
      condicion_cierre: 'add bun test',
      ronda_entrada: 1,
      estado: 'abierto',
    },
  ])
  const late = parsearVeredicto('VEREDICTO: OBJECIONES\nACTA: 1 | cerrado\nOBJECION: T2 | old typo | typo | fix typo')
  // Given: closure on acta 1 plus a new objection without justification; When: the next round is applied.
  const effective = admitir(late, 2, initial)
  const final = db.transaction(() =>
    actualizarActa(db, 'plan.md', 2, [effective, parsearVeredicto('VEREDICTO: APROBADO\nACTA: 1 | cerrado')]),
  )()

  // Then: no new acta entry blocks closure; the late issue is a note.
  expect(final).toHaveLength(1)
  expect(final[0]?.estado).toBe('cerrado')
  expect(effective.notas).toContain('T2: old typo')
  expect(cerrado([effective, approved], final, ['new-hash', 'new-hash'])).toBe(true)
  db.close()
})

test('approval closes only when both reviewers approved the same hash and all acta entries closed', () => {
  // Given: two approvals and a closed acta entry; When: hashes diverge; Then: no closure.
  const veredicto = parsearVeredicto('VEREDICTO: APROBADO')
  const entry = {
    plan: 'p',
    id: 1,
    objecion: 'T1',
    causa: 'x',
    condicion_cierre: 'fix',
    ronda_entrada: 1,
    estado: 'cerrado' as const,
  }

  expect(cerrado([veredicto, veredicto], [entry], ['one', 'two'])).toBe(false)
  expect(cerrado([veredicto, veredicto], [{ ...entry, estado: 'abierto' }], ['one', 'one'])).toBe(false)
  expect(cerrado([veredicto, veredicto], [entry], ['one', 'one'])).toBe(true)
})
