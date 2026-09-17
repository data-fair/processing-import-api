import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import { getValueByPath } from './utils.ts'

// The nested block of an expand is declared under `dependencies` in the schema (shown once the
// path is filled), which the type generator leaves untyped: it is restored here.
export type Block = ProcessingConfig['block'] & { expand?: { path?: string, block?: Block } }

/**
 * Flatten a single data object into one or several CSV rows following the block configuration.
 */
export const flattenData = (data: any, block?: Block, separator = ';', common: Record<string, any> = {}): Array<Record<string, any>> => {
  let base: Record<string, any> = {}
  if (block?.mapping?.length) {
    base = Object.assign({}, ...block.mapping.map(m => {
      const values = getValueByPath(data, m.path)
      if (values == null) return {}
      return { [m.key]: (values.constructor === Array) ? values.join(separator) : getValueByPath(data, m.path) }
    }))
  }
  if (block?.expand?.path) {
    return ([] as Array<Record<string, any>>).concat(...getValueByPath(data, block.expand.path).map((d: any) => flattenData(d, block.expand?.block, separator, { ...base, ...common })))
  } else return [{ ...base, ...common }]
}

/**
 * Compute the ordered list of CSV columns from the block configuration.
 */
export const blockHeaders = (block?: Block): string[] => {
  const base = (block?.mapping ?? []).map(m => m.key)
  if (block?.expand?.path) {
    return base.concat(blockHeaders(block.expand.block))
  } else return base
}
