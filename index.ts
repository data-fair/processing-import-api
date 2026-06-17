import type { ProcessingContext, PrepareFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from './types/processingConfig/index.ts'
import type { Auth, Block, PaginationConfig } from './lib/types.ts'
import util from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import FormData from 'form-data'
import slugify from 'slugify'
import { stringify } from 'csv-stringify/sync'
import getAuthHeaders from './lib/authentications.ts'
import { getValueByPath } from './lib/utils.ts'

type ImportApiContext = ProcessingContext<ProcessingConfig>

const getPageUrl = async (context: ImportApiContext, offset: number, data?: any, lines?: any[]): Promise<string | null> => {
  const url = (context.processingConfig as any).apiURL as string
  const paginationConfig = (context.processingConfig as any).pagination as PaginationConfig | undefined

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
    return getValueByPath(data, paginationConfig.nextPagePath)
  }
  return null
}

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

export const run = async (context: ImportApiContext, noUpload = false) => {
  const { processingConfig, processingId, tmpDir, axios, log, patchConfig } = context
  const cfg = processingConfig as any

  // ------------------ Récupération, conversion et envoi des données ------------------
  await log.step('Récupération et conversion des données')
  let headers: Record<string, string> = { Accept: 'application/json' }
  if (cfg.auth && cfg.auth.authMethod !== 'noAuth') {
    if (context.secrets) {
      for (const key of ['password', 'apiKeyValue', 'clientSecret']) {
        if (cfg.auth[key] === '********' && context.secrets[key]) {
          cfg.auth[key] = context.secrets[key]
        }
      }
    }

    const authHeader = await getAuthHeaders(cfg.auth as Auth, axios, log)
    headers = { ...headers, ...authHeader }
  }

  let offset = cfg.pagination?.offsetPages ? 1 : 0
  let nextPageURL: string | null = await getPageUrl(context, offset)
  const filename = slugify(cfg.dataset.title, { lower: true, strict: true }) + '.csv'
  const writeStream = fs.createWriteStream(path.join(tmpDir, filename), { flags: 'w' })
  const columns = blockHeaders(cfg.block)
  let header = true
  while (nextPageURL) {
    await log.info(`Récupération de ${nextPageURL}`)
    const results = await axios({
      method: 'get',
      url: nextPageURL,
      headers,
      timeout: 10 * 60000 // very long timeout as we don't control the API and some export logic are very slow
    })
    const data = getValueByPath(results.data, cfg.resultsPath)
    if (!data) {
      await log.warning('Aucune donnée n\'a été récupérée')
      break
    }
    await log.info(`Conversion de ${data.length || 1} lignes`)
    const lines = ([] as Array<Record<string, any>>).concat(...(Array.isArray(data) ? data : [data]).map((d: any) => flattenData(d, cfg.block, cfg.separator)))

    if (lines.length === 0) {
      await log.warning('Aucune donnée n\'a été récupérée')
      break
    } else if (data.length > 10000) {
      await log.warning('Le nombre de lignes est trop important, privilégier une pagination plus petite.')
    }

    if (cfg.pagination?.offsetPages) offset++
    else offset += data.length
    nextPageURL = await getPageUrl(context, offset, results.data, (Array.isArray(data) ? data : [data]))

    await log.info(`Création de ${lines.length} lignes`)
    await writeStream.write(stringify(lines, { header, columns, quoted: true }))
    header = false
  }
  if (!noUpload) {
    await log.step('Chargement des données')
    const formData: any = new FormData()
    formData.append('title', cfg.dataset.title)
    formData.append('extras', JSON.stringify({ processingId }))
    formData.append('file', fs.createReadStream(path.join(tmpDir, filename)), { filename })
    formData.getLength = util.promisify(formData.getLength)

    try {
      const dataset = (await axios({
        method: 'post',
        url: 'api/v1/datasets/' + (cfg.dataset.id || ''),
        data: formData,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: { ...formData.getHeaders(), 'content-length': await formData.getLength() }
      })).data
      await log.info(`jeu de donnée ${cfg.datasetMode === 'update' ? 'mis à jour' : 'créé'}, id="${dataset.id}", title="${dataset.title}"`)
      if (cfg.datasetMode === 'create') {
        await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
      }
    } catch (err) {
      console.log(JSON.stringify(err, null, 2))
    }
    await log.info('Toutes les données ont été envoyées')
    await log.info('Suppression du fichier CSV temporaire')
    fs.unlinkSync(path.join(tmpDir, filename))
  }
}

export const prepare: PrepareFunction<ProcessingConfig> = async ({ processingConfig, secrets }) => {
  const auth = (processingConfig as any).auth as Auth | undefined
  if (!auth) return { processingConfig, secrets }

  for (const key of ['password', 'apiKeyValue', 'clientSecret']) {
    if (auth[key] && auth[key] !== '********') {
      secrets[key] = auth[key]
      auth[key] = '********'
    }
    if (!auth[key] && secrets[key]) {
      delete secrets[key]
    }
  }

  return {
    processingConfig,
    secrets
  }
}
