import { expect, test } from 'bun:test'

test('el singleton persiste entre dos cargas distintas del módulo', async () => {
  // Given: una segunda instancia del módulo con otro specifier.
  const primera = await import('../src/process.ts')
  const specifier = '../src/process.ts?segunda-copia'
  const segunda: typeof primera = await import(specifier)

  // When: Bun carga una copia nueva; Then: el estado compartido conserva su identidad.
  expect(segunda).not.toBe(primera)
  expect(segunda.proceso).toBe(primera.proceso)
})
