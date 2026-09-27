import type { ContextoEncargos } from '../src/encargos-types.ts'

type Sesiones = ContextoEncargos['session']

export function sesionNativa(campos: Partial<Awaited<ReturnType<Sesiones['get']>>> = {}) {
  return { location: { directory: '/tmp' }, time: {}, ...campos }
}

export function sesionesDobles(metodos: Partial<Sesiones> = {}): Sesiones {
  return {
    get: async () => {
      throw new Error('inesperado: session.get')
    },
    create: async () => {
      throw new Error('inesperado: session.create')
    },
    context: async () => {
      throw new Error('inesperado: session.context')
    },
    prompt: async () => {
      throw new Error('inesperado: session.prompt')
    },
    wait: async () => {
      throw new Error('inesperado: session.wait')
    },
    interrupt: async () => {
      throw new Error('inesperado: session.interrupt')
    },
    ...metodos,
  }
}
