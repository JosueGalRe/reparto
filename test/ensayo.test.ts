import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, expect, test } from 'bun:test'

import { openDb } from '../src/db.ts'
import {
  actualizarActa,
  admitir,
  cerrado,
  elegirRevisores,
  ensayo,
  ensayoTerminado,
  leerVeredicto,
  parsearVeredicto,
  revisores,
} from '../src/ensayo.ts'
import { envioSinEnsayo } from '../src/hooks.ts'
import { proceso } from '../src/process.ts'

import type { Validacion } from '../src/actores.ts'
import type { ContextoRevisores, Veredicto } from '../src/ensayo.ts'

const dir = mkdtempSync(join(tmpdir(), 'reparto-ensayo-'))
const validacionRevisores: Validacion = {
  actores: new Map([
    ['critico', [{ model: 'kimi-code-plan-global/k3' }]],
    ['tiresias', [{ model: 'claude-code/haiku' }]],
  ]),
  exclusiones: [],
  desactivados: [],
  desconocidos: [],
}

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
  // Given: dos aprobaciones aparentes del texto actual, una de ellas sin notas ni cierres.
  const contenido = '### T1: comprobar\n'

  using database = openDb(':memory:')
  const previo = proceso.db

  proceso.db = database

  try {
    for (const revisor of ['critico', 'tiresias']) {
      database
        .query('INSERT INTO ensayos VALUES (?, 1, ?, ?, ?, ?)')
        .run(
          'ses_padre',
          createHash('sha256').update(contenido).digest('hex'),
          revisor,
          'p/m',
          JSON.stringify(
            revisor === 'critico' ? { veredicto: 'APROBADO', objeciones: [] } : parsearVeredicto('VEREDICTO: APROBADO'),
          ),
        )
    }

    const ejecutar = ensayo({ session: { get: async () => ({ agent: 'plan' }) } }, async () => {
      throw new Error('no debe relanzar un ensayo corrupto')
    })

    // When: se reensaya; Then: el mismo lector impide anunciar el cierre de una revisión corrupta.
    await expect(
      ejecutar({ plan: contenido }, { sessionID: 'ses_padre', signal: new AbortController().signal }),
    ).rejects.toThrow(/veredicto guardado: notas/)
    expect(() => ensayoTerminado(database, 'ses_padre')).toThrow(/veredicto guardado: notas/)
  } finally {
    proceso.db = previo
  }
})

const sinRevisores = async () => {
  throw new Error('no debe lanzar revisores')
}

test('solo el Compositor (plan) ensaya, y un plan vacío no abre ronda', async () => {
  const tool = { sessionID: 'ses_x', signal: new AbortController().signal }

  await expect(
    ensayo({ session: { get: async () => ({ agent: 'build' }) } }, sinRevisores)({ plan: '# P' }, tool),
  ).rejects.toThrow(/solo el Compositor/)
  await expect(
    ensayo({ session: { get: async () => ({ agent: 'plan' }) } }, sinRevisores)({ plan: '  ' }, tool),
  ).rejects.toThrow(/vacío/)
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

test('OBJECIONES with only an open acta entry parses in closure rounds', () => {
  // Given: an unresolved prior objection but no new objection.
  const texto = 'VEREDICTO: OBJECIONES\nACTA: 1 | abierto'

  // When: the closure review is parsed; Then: the prior objection can keep the round open.
  expect(parsearVeredicto(texto)).toEqual({ veredicto: 'OBJECIONES', objeciones: [], notas: [], cierres: { 1: 'abierto' } })
})

test('a malformed reviewer leaves the round pending and relaunches fresh reviewers', async () => {
  // Given: one malformed review in a first round and valid reviews on retry.
  const database = openDb(join(dir, 'retry.db'))
  const previous = { db: proceso.db, validacion: proceso.validacion }

  proceso.db = database
  proceso.validacion = validacionRevisores
  let launched = 0
  const run = ensayo({ session: { get: async () => ({ agent: 'plan' }) } }, async () => {
    launched++

    return {
      hija: `ses_retry_${launched}`,
      actor: 'p/m',
      mensaje: launched === 1 ? 'VEREDICTO: OBJECIONES\nOBJECION: malformed' : 'VEREDICTO: APROBADO',
    }
  })
  const tool = { sessionID: 'parent', signal: new AbortController().signal }

  try {
    // When: the malformed review fails; Then: the round stays pending, not approved, and submit_plan stays gated.
    await expect(run({ plan: '### T1: check\n' }, tool)).rejects.toThrow(/ronda 1 incompleta/)
    expect(database.query('SELECT DISTINCT veredicto FROM ensayos').all()).toEqual([{ veredicto: 'pendiente' }])
    expect(ensayoTerminado(database, 'parent')).toBe(false)
    // When: retried; Then: both reviewers are relaunched and can close the round.
    const acta = await run({ plan: '### T1: check\n' }, tool)

    expect(JSON.parse(acta.content).cerrado).toBe(true)
    expect(launched).toBe(4)
    expect(ensayoTerminado(database, 'parent')).toBe(true)
  } finally {
    proceso.db = previous.db
    proceso.validacion = previous.validacion
    database.close()
  }
})

test('selects distinct available providers, or marks repeated providers after bajas', () => {
  // Given: the compositor uses openai, and tiresias has one alternate provider.
  const validacion: Validacion = {
    actores: new Map([
      ['critico', [{ model: 'openai/cheap' }, { model: 'kimi-code-plan-global/cheap' }]],
      ['tiresias', [{ model: 'openai/other' }, { model: 'opencode-go/cheap' }]],
    ]),
    exclusiones: [],
    desactivados: [],
    desconocidos: [],
  }

  // When: all actors are available; Then: neither reviewer shares the compositor's provider.
  expect(elegirRevisores(validacion, 'openai', () => false)).toEqual({
    critico: { model: 'kimi-code-plan-global/cheap' },
    tiresias: { model: 'opencode-go/cheap' },
    repetidos: false,
  })
  // Even if one reviewer must share the compositor's provider, keep the reviewers distinct.
  expect(elegirRevisores(validacion, 'openai', (actor) => actor.model.startsWith('kimi-code-plan-global/'))).toEqual({
    critico: { model: 'openai/cheap' },
    tiresias: { model: 'opencode-go/cheap' },
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

/** Sesiones dobles para `revisores`: cada `create` da una hija que termina con `veredicto`. */
function sesionesRevisor(veredicto: string) {
  const creaciones: Parameters<ContextoRevisores['session']['create']>[0][] = []
  const prompts: Parameters<ContextoRevisores['session']['prompt']>[0][] = []
  const interrupciones: string[] = []
  const salidas = new Map<string, 'succeeded' | 'interrupted'>()
  const ctx: ContextoRevisores = {
    session: {
      get: async ({ sessionID }) => ({
        location: { directory: '/tmp/repo' },
        outcome: salidas.get(sessionID),
        model: creaciones.at(-1)?.model ?? undefined,
      }),
      create: async (entrada) => {
        const id = `ses_revisor_${creaciones.push(entrada)}`

        salidas.set(id, 'succeeded')

        return { id }
      },
      prompt: async (entrada) => {
        prompts.push(entrada)
      },
      context: async () => [{ type: 'assistant', content: [{ type: 'text', text: veredicto }] }],
      wait: async () => {},
      interrupt: async ({ sessionID }) => {
        interrupciones.push(sessionID)
        salidas.set(sessionID, 'interrupted')
      },
    },
  }

  return { ctx, creaciones, prompts, interrupciones, salidas }
}

test('revisores crea la hija con el actor elegido y devuelve el mensaje final completo', async () => {
  // Given: an actor other than the titular and a verdict longer than any old bitácora cap.
  const veredicto = `VEREDICTO: APROBADO\nNOTA: ${'x'.repeat(40_000)}`
  const { ctx, creaciones, prompts } = sesionesRevisor(veredicto)
  const tool = { sessionID: 'ses_plan', signal: new AbortController().signal }

  // When: a reviewer runs.
  const resultado = await revisores(ctx)('critico', 'Revisa el plan', tool, { model: 'kimi/revisor', variant: 'thinking' })

  // Then: the child is tied to the plan session by metadata, not parentID, and runs with the chosen actor.
  expect(resultado).toEqual({ hija: 'ses_revisor_1', actor: 'kimi/revisor#thinking', mensaje: veredicto })
  expect(creaciones).toMatchObject([
    {
      agent: 'critico',
      model: { providerID: 'kimi', id: 'revisor', variant: 'thinking' },
      metadata: { padre: 'ses_plan' },
      location: { directory: '/tmp/repo' },
      permissions: [{ action: 'external_directory', resource: '*', effect: 'deny' }],
    },
  ])
  expect(creaciones[0]).not.toHaveProperty('parentID')
  expect(prompts).toEqual([{ sessionID: 'ses_revisor_1', text: 'Revisa el plan' }])
})

test('revisores interrumpe la hija si se cancela la tool y falla sin veredicto', async () => {
  // Given: wait blocks until the tool call is aborted.
  const { ctx, interrupciones } = sesionesRevisor('VEREDICTO: APROBADO')
  const control = new AbortController()
  const esperando = Promise.withResolvers<void>()
  const terminado = Promise.withResolvers<void>()

  ctx.session.wait = async () => {
    esperando.resolve()
    await terminado.promise
  }

  const pendiente = revisores(ctx)('tiresias', 'Revisa', { sessionID: 'ses_plan', signal: control.signal }, { model: 'a/b' })

  await esperando.promise
  // When: the tool is cancelled.
  control.abort()
  terminado.resolve()

  // Then: the child is interrupted once and the round cannot read a verdict from it.
  await expect(pendiente).rejects.toThrow(/terminó interrupted/)
  control.signal.dispatchEvent(new Event('abort'))
  expect(interrupciones).toEqual(['ses_revisor_1'])
})

test('un ensayo completo con revisores reales cierra y no relanza una ronda ya cerrada', async () => {
  // Given: both reviewers approve.
  const { ctx, creaciones } = sesionesRevisor('VEREDICTO: APROBADO')
  const database = openDb(join(dir, 'completo.db'))
  const previous = { db: proceso.db, validacion: proceso.validacion }

  proceso.db = database
  proceso.validacion = validacionRevisores
  const ensayar = ensayo({ session: { get: async () => ({ agent: 'plan' }) } }, revisores(ctx))
  const tool = { sessionID: 'ses_plan', signal: new AbortController().signal }

  try {
    // When: the same text is rehearsed twice.
    const primera = await ensayar({ plan: '# Plan\n' }, tool)
    const repetida = await ensayar({ plan: '# Plan\n' }, tool)

    // Then: the first round closes and the repeat reuses it without new children.
    expect(JSON.parse(primera.content)).toMatchObject({ cerrado: true, ronda: 1 })
    expect(JSON.parse(repetida.content)).toMatchObject({ cerrado: true, ronda: 1 })
    expect(creaciones.map((creacion) => creacion?.agent)).toEqual(['critico', 'tiresias'])
  } finally {
    proceso.db = previous.db
    proceso.validacion = previous.validacion
    database.close()
  }
})

test('submit_plan: rechazado sin ensayo terminado; pasa con la ronda cerrada, en la ronda 5 o sin revisores', () => {
  const database = openDb(join(dir, 'gate.db'))
  const previous = { db: proceso.db, validacion: proceso.validacion }
  const guardarRonda = (plan: string, ronda: number, veredicto: string) => {
    for (const revisor of ['critico', 'tiresias']) {
      database.query('INSERT INTO ensayos VALUES (?, ?, ?, ?, ?, ?)').run(plan, ronda, 'h', revisor, 'p/m', veredicto)
    }
  }
  const aprobado = JSON.stringify(parsearVeredicto('VEREDICTO: APROBADO'))
  const objetado = JSON.stringify(parsearVeredicto('VEREDICTO: OBJECIONES\nOBJECION: T1 | a | b | c'))

  proceso.db = database
  proceso.validacion = validacionRevisores

  try {
    // Given: no ensayo, a pending round, and an objected round; Then: all rejected with a pointer to ensayar.
    expect(envioSinEnsayo('submit_plan', 'ses_nada')).toContain('ensayar')
    guardarRonda('ses_pendiente', 1, 'pendiente')
    expect(envioSinEnsayo('submit_plan', 'ses_pendiente')).toBeDefined()
    guardarRonda('ses_objetado', 1, objetado)
    expect(envioSinEnsayo('submit_plan', 'ses_objetado')).toBeDefined()
    // Given: a closed round, or round 5 without closure (Bryan decides); Then: it passes.
    guardarRonda('ses_cerrado', 1, aprobado)
    expect(envioSinEnsayo('submit_plan', 'ses_cerrado')).toBeUndefined()
    guardarRonda('ses_quinta', 5, objetado)
    expect(envioSinEnsayo('submit_plan', 'ses_quinta')).toBeUndefined()
    // Other tools are untouched.
    expect(envioSinEnsayo('edit', 'ses_nada')).toBeUndefined()
    // Given: no reviewer can run; Then: the plan goes straight to Bryan.
    proceso.validacion = { ...validacionRevisores, actores: new Map() }
    expect(envioSinEnsayo('submit_plan', 'ses_nada')).toBeUndefined()
  } finally {
    proceso.db = previous.db
    proceso.validacion = previous.validacion
    database.close()
  }
})
