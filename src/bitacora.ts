import { db, write } from './db.ts'
import { argumentoClave, recortar } from './encargos-utils.ts'
import { abiertos } from './process.ts'
import { esRegistro } from './validation-utils.ts'

import type { ContextoEncargos, Encargo } from './encargos-types.ts'

const TOPE_RESULTADO = 4_000

export function bitacoraEncargos(ctx: ContextoEncargos) {
  async function mensajeFinal(hija: string): Promise<string | undefined> {
    const mensajes = await ctx.session.context({ sessionID: hija })

    for (const mensaje of mensajes.toReversed()) {
      if (mensaje.type !== 'assistant') {
        continue
      }

      const texto = mensaje.content
        .flatMap((parte) => (parte.type === 'text' ? [parte.text] : []))
        .join('\n')
        .trim()

      if (texto) {
        return texto
      }
    }
  }

  async function bitacora(entrada: unknown) {
    if (!esRegistro(entrada) || typeof entrada.id !== 'string') {
      throw new Error('bitacora: falta `id` (el id de la sesión hija)')
    }

    const encargo = db()
      .query<Encargo, { hija: string }>('SELECT * FROM encargos WHERE hija = $hija ORDER BY id DESC LIMIT 1')
      .get({ hija: entrada.id })
    const sesion = encargo ? undefined : await ctx.session.get({ sessionID: entrada.id }).catch(() => undefined)

    if (!encargo && !sesion?.parentID) {
      throw new Error(`${entrada.id} no es un encargo de reparto`)
    }

    const completo = entrada.detalle === 'completo'
    const llamadas = db()
      .query<
        {
          tool: string
          argumentos: string
          resultado: string | null
          estado: string
        },
        { hija: string }
      >('SELECT tool, argumentos, resultado, estado FROM bitacora WHERE hija = $hija ORDER BY hora')
      .all({ hija: entrada.id })
    const lineas = llamadas.map((llamada) => {
      const base = `- ${llamada.tool} ${argumentoClave(llamada.argumentos)}${llamada.estado === 'error' ? ' [error]' : ''}`

      return completo && llamada.resultado ? `${base}\n  → ${llamada.resultado.replaceAll('\n', '\n    ')}` : base
    })
    const final = db()
      .query<{ texto: string }, { hija: string }>('SELECT texto FROM mensajes_hijas WHERE hija = $hija')
      .get({ hija: entrada.id })

    return {
      content: [
        encargo
          ? `Encargo ${encargo.hija} (${encargo.a}, ${encargo.actor}): ${encargo.estado}${encargo.error ? ` (${encargo.error})` : ''}.`
          : `Encargo ${entrada.id} (${sesion?.agent}): ${sesion?.outcome ?? 'abierto'}.`,
        `Tool calls (${llamadas.length}):`,
        lineas.join('\n') || '(ninguna)',
        `Mensaje final:`,
        encargo?.mensaje_final ?? final?.texto ?? (sesion ? await mensajeFinal(entrada.id) : undefined) ?? '(todavía no hay)',
      ].join('\n\n'),
    }
  }

  async function registrarLlamada(llamada: {
    tool: string
    sessionID: string
    messageID: string
    id: string
    input: unknown
    status: 'completed' | 'error'
    result?: { content?: unknown }
    error?: { message: string }
  }) {
    if (!abiertos().has(llamada.sessionID)) {
      const sesion = await ctx.session.get({ sessionID: llamada.sessionID }).catch(() => undefined)

      if (!sesion?.parentID) {
        return
      }
    }

    let resultado: string

    if (llamada.status === 'error') {
      resultado = llamada.error?.message ?? ''
    } else if (typeof llamada.result?.content === 'string') {
      resultado = llamada.result.content
    } else {
      resultado = JSON.stringify(llamada.result?.content ?? '')
    }

    write(db(), 'bitácora', () =>
      db()
        .query(
          `INSERT OR IGNORE INTO bitacora (hija, mensaje, llamada, tool, argumentos, resultado, estado, hora)
           VALUES ($hija, $mensaje, $llamada, $tool, $argumentos, $resultado, $estado, $hora)`,
        )
        .run({
          hija: llamada.sessionID,
          mensaje: llamada.messageID,
          llamada: llamada.id,
          tool: llamada.tool,
          argumentos: JSON.stringify(llamada.input ?? {}),
          resultado: recortar(resultado, TOPE_RESULTADO),
          estado: llamada.status,
          hora: Date.now(),
        }),
    )
  }

  return { mensajeFinal, registrarLlamada, bitacora }
}
