import { db } from './db.ts'
import { escribirPendientes, estados, formatear, leerPendientes, parsearItems } from './pendientes.ts'

import type { ensayo } from './ensayo.ts'
import type { Plugin } from '@opencode/plugin'

export async function registrarTools(ctx: Plugin.Context, ensayar: ReturnType<typeof ensayo>) {
  // Codemode: false, o el modelo solo las alcanza desde `execute` (S11)
  await ctx.tool.transform((editor) => {
    editor.add({
      name: 'ensayar',
      description:
        'Run one synchronous round of the ensayo general on the full plan text. Fresh parallel critico and tiresias reviewers on providers other than yours; returns their verdicts and the acta. ' +
        '`submit_plan` is denied until a round closes or round 5 is reached.',
      input: {
        type: 'object',
        properties: { plan: { type: 'string', description: 'The full plan, as Markdown: the exact text you will submit.' } },
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

        if (items && !escribirPendientes(db(), tool.sessionID, items)) {
          throw new Error('pendientes: no se pudo guardar (SQLite); ver el log de reparto')
        }

        return { content: formatear(items ?? leerPendientes(db(), tool.sessionID)) }
      },
    })
  })
}
