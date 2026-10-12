import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import { getValueByPath } from './utils.ts'

type PaginationConfig = ProcessingConfig['pagination']

/**
 * URL of the next page to fetch, or null when the pagination is over.
 * `data` and `lines` are the body and the results of the page just read, absent on the first call.
 */
export const getPageUrl = async (context: ProcessingContext<ProcessingConfig>, offset: number, data?: any, lines?: any[]): Promise<string | null> => {
  const url = context.processingConfig.apiURL
  const paginationConfig: PaginationConfig = context.processingConfig.pagination

  if (!paginationConfig || paginationConfig.method === 'none') return data ? null : url
  if (paginationConfig.method === 'queryParams') {
    const urlObj = new URL(url)
    if (paginationConfig.limitKey) {
      if (lines && paginationConfig.limitValue && lines.length < paginationConfig.limitValue) {
        await context.log.info('Le nombre de lignes récupérées est inférieur au nombre de lignes demandé, fin de la pagination.')
        return null
      }
      await context.log.debug(`Limit parameter: ${paginationConfig.limitKey}=${paginationConfig.limitValue}`)
      urlObj.searchParams.set(paginationConfig.limitKey, paginationConfig.limitValue + '')
    }
    await context.log.debug(`Offset parameter: ${paginationConfig.offsetKey}=${offset}`)
    urlObj.searchParams.set(paginationConfig.offsetKey as string, offset + '')
    return urlObj.href
  }
  if (paginationConfig.method === 'nextPageData') {
    if (!data) {
      const urlObj = new URL(url)
      if (paginationConfig.limitKey) {
        await context.log.debug(`Limit parameter: ${paginationConfig.limitKey}=${paginationConfig.limitValue}`)
        urlObj.searchParams.set(paginationConfig.limitKey, paginationConfig.limitValue + '')
      }
      return urlObj.href
    }
    const next = getValueByPath(data, paginationConfig.nextPagePath)
    // a relative link is relative to the API, never to data-fair
    return next ? new URL(next, url).href : null
  }
  return null
}

/**
 * Credentials of the configured API are only sent to its own origin: a next page link comes from
 * the remote server and can point anywhere.
 */
export const isSameOrigin = (url: string, apiURL: string): boolean => {
  try {
    return new URL(url).origin === new URL(apiURL).origin
  } catch {
    return false
  }
}
