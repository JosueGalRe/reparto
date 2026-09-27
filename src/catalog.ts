import type { ModelEditor } from '@opencode/plugin/promise/model'

export interface CatalogModel {
  enabled: boolean
  variants: readonly string[]
}

/** Keyed by `<providerID>/<id>`. Includes disabled candidates (S9). */
export type Catalog = ReadonlyMap<string, CatalogModel>

// Read-only: reparto never edits the catalog, it only validates actors against it.
export function readCatalog(editor: ModelEditor): Catalog {
  return new Map(
    editor
      .list()
      .map((model) => [
        `${model.providerID}/${model.id}`,
        { enabled: model.enabled, variants: model.variants.map((variant) => String(variant.id)) },
      ]),
  )
}
