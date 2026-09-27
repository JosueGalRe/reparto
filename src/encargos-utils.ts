import { etiqueta } from './actores.ts'
import { esRegistro } from './validation-utils.ts'

import type { Encargo } from './encargos-types.ts'

export const recortar = (texto: string, tope: number) =>
  texto.length > tope ? `${texto.slice(0, tope)}\n[… recortado, ${texto.length - tope} caracteres más]` : texto

export function tituloEncargo(agente: string, prompt: string): string {
  const resumen = (prompt.split('\n').find((linea) => linea.trim()) ?? '').trim().replace(/\s+/g, ' ')

  return `${agente} · ${resumen.length > 60 ? `${resumen.slice(0, 60)}…` : resumen}`
}

/** Un evento o un outcome cuenta para la fila solo si es posterior a `desde`: el `outcome` es el de la última ejecución de la sesión. */
export const posterior = (instante: number | undefined, desde: number | null) =>
  instante !== undefined && desde !== null && instante > desde

export const etiquetaRef = (modelo: { providerID: string; id: string; variant?: string } | undefined) =>
  modelo ? etiqueta({ model: `${modelo.providerID}/${modelo.id}`, variant: modelo.variant }) : 'desconocido'

export const estaAbierto = (encargo: Encargo | null) =>
  !!encargo && (encargo.estado === 'en_cola' || encargo.estado === 'corriendo' || encargo.estado === 'estancado')

const clavesArgumento = ['command', 'pattern', 'filePath', 'path', 'query', 'url', 'a']

export function argumentoClave(argumentos: string): string {
  let entrada: unknown

  try {
    entrada = JSON.parse(argumentos)
  } catch {
    return recortar(argumentos, 160)
  }

  if (!esRegistro(entrada)) {
    return ''
  }

  const clave =
    clavesArgumento.find((clave) => typeof entrada[clave] === 'string') ??
    Object.keys(entrada).find((clave) => typeof entrada[clave] === 'string')

  return clave ? `${clave}=${recortar(String(entrada[clave]), 160).replaceAll('\n', ' ')}` : ''
}
