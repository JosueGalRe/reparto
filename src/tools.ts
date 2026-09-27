import { db } from './db.ts'
import { clavePlan, planDeSesion } from './estreno.ts'
import { escribirPendientes, estados, formatear, leerPendientes, parsearItems } from './pendientes.ts'

import type { encargos } from './encargos.ts'
import type { ensayo } from './ensayo.ts'
import type { Plugin } from '@opencode/plugin'

export async function registrarTools(
  ctx: Plugin.Context,
  gestor: ReturnType<typeof encargos>,
  ensayar: ReturnType<typeof ensayo>,
) {
  // Codemode: false, o el modelo solo las alcanza desde `execute` (S11)
  await ctx.tool.transform((editor) => {
    editor.add({
      name: 'bitacora',
      description:
        'Show what an encargo did: its tool calls with their key argument, and its final message. `detalle: "completo"` adds the (trimmed) results. Works after the child was compacted.',
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Child session id of the encargo.' },
          detalle: { type: 'string', enum: ['completo'] },
        },
        required: ['id'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: (input) => gestor.bitacora(input),
    })
    editor.add({
      name: 'ensayar',
      description:
        'Run one synchronous round of the ensayo general on a plan under .reparto/planes/. Fresh parallel critico and oracle encargos; returns verdicts and the acta.',
      input: {
        type: 'object',
        properties: { plan: { type: 'string', description: 'Relative plan path under .reparto/planes/.' } },
        required: ['plan'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: (input, tool) => {
        if (!input || typeof input !== 'object' || !('plan' in input) || typeof input.plan !== 'string') {
          throw new Error('ensayar: falta plan')
        }

        return ensayar({ plan: input.plan }, tool)
      },
    })
    editor.add({
      name: 'interrumpir',
      description:
        'Interrupt one of your own open encargos (for example a stale one). Only encargos this session launched can be interrupted. ' +
        'Native children receive their completion through the native subagent tool.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Child session id of the encargo.' } },
        required: ['id'],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: (input, tool) => gestor.interrumpir(input, tool),
    })
    editor.add({
      name: 'pendientes',
      description:
        "Read or rewrite this session's work list. Without `items` it returns the list; with `items` it replaces the whole list and returns it. " +
        'Survives compaction. Keep one item `en_curso` at a time and mark items `hecho` as soon as they are done.',
      input: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { texto: { type: 'string' }, estado: { type: 'string', enum: [...estados] } },
              required: ['texto'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input, tool) => {
        const items = parsearItems(input)
        const sesion = await ctx.session.get({ sessionID: tool.sessionID })
        const ref = sesion.agent === 'regidor' ? planDeSesion(db(), tool.sessionID) : undefined
        const clave = ref ? clavePlan(ref) : tool.sessionID

        if (items && ref) {
          const original = leerPendientes(db(), clave)

          if (items.length !== original.length || items.some((item, indice) => item.texto !== original[indice]?.texto)) {
            throw new Error('pendientes: las tareas estrenadas no se pueden agregar, borrar ni renombrar')
          }
        }

        if (items && !escribirPendientes(db(), clave, items)) {
          throw new Error('pendientes: no se pudo guardar (SQLite); ver el log de reparto')
        }

        return { content: formatear(items ?? leerPendientes(db(), clave)) }
      },
    })
  })
}
