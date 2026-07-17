import type { ProcessingContext, PrepareFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from './types/processingConfig/index.ts'
import type { Auth, Block, PaginationConfig } from './lib/types.ts'
import util from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import FormData from 'form-data'
import slugify from 'slugify'
import { stringify } from 'csv-stringify/sync'
import getAuthHeaders from './lib/authentications.ts'
import { getValueByPath } from './lib/utils.ts'

type ImportApiContext = ProcessingContext<ProcessingConfig>

/**
 * Data Fair reports why it rejected a call in the response body. Both axios instances used
 * by a processing reject with a response-like object rather than an AxiosError, and they
 * don't agree on its shape: the runtime one carries a formatted `message`, the test harness
 * only the raw body. Read the body first, it is the actionable part.
 */
export const errorMessage = (err: any): string => {
  const data = err?.response?.data ?? err?.data
  if (typeof data === 'string' && data) return data
  if (typeof data?.message === 'string') return data.message
  if (data) return JSON.stringify(data)
  if (typeof err?.message === 'string') return err.message
  const status = err?.response?.status ?? err?.status
  return status ? `HTTP ${status}` : String(err)
}

const errorStatus = (err: any): number | undefined => err?.response?.status ?? err?.status

/**
 * Write to a stream while honouring backpressure, so that large exports don't pile up in memory.
 */
const writeChunk = (stream: fs.WriteStream, chunk: string): Promise<void> => {
  if (stream.write(chunk)) return Promise.resolve()
  return new Promise((resolve) => stream.once('drain', resolve))
}

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

/**
 * Read the target dataset to route the upload. An editable dataset only accepts lines through
 * _bulk_lines: Data Fair rejects a file posted on it with "this dataset is not file based".
 */
const getTargetDataset = async (context: ImportApiContext, datasetId: string) => {
  try {
    return (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
  } catch (err: any) {
    if (errorStatus(err) === 404) {
      throw new Error(`Le jeu de données id="${datasetId}" n'existe pas, il a peut-être été supprimé.`)
    }
    throw new Error(`Impossible de lire le jeu de données id="${datasetId}" : ${errorMessage(err)}`)
  }
}

const uploadToFileDataset = async (context: ImportApiContext, filePath: string, filename: string) => {
  const { processingConfig, processingId, axios, log, patchConfig } = context
  const cfg = processingConfig as any

  const formData: any = new FormData()
  formData.append('title', cfg.dataset.title)
  formData.append('extras', JSON.stringify({ processingId }))
  formData.append('file', fs.createReadStream(filePath), { filename })
  formData.getLength = util.promisify(formData.getLength)

  let dataset
  try {
    dataset = (await axios({
      method: 'post',
      url: 'api/v1/datasets/' + (cfg.dataset.id || ''),
      data: formData,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: { ...formData.getHeaders(), 'content-length': await formData.getLength() }
    })).data
  } catch (err) {
    throw new Error(`Le chargement du fichier a échoué : ${errorMessage(err)}`)
  }

  await log.info(`jeu de donnée ${cfg.datasetMode === 'update' ? 'mis à jour' : 'créé'}, id="${dataset.id}", title="${dataset.title}"`)
  if (cfg.datasetMode === 'create') {
    await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
  }
  await log.info('Toutes les données ont été envoyées')
}

/**
 * An editable dataset takes the very CSV we already produced, as a multipart "actions" part.
 * _bulk_lines never derives the schema from the data, so columns the dataset doesn't declare
 * would make Data Fair reject the whole stream: check them first to fail with a message that
 * says what to fix.
 */
const uploadToEditableDataset = async (
  context: ImportApiContext,
  dataset: any,
  filePath: string,
  filename: string,
  totalLines: number,
  columns: string[]
) => {
  const { processingConfig, axios, log } = context
  const drop = (processingConfig as any).drop === true

  const declared = new Set<string>()
  for (const prop of dataset.schema ?? []) {
    if (prop['x-calculated'] || prop['x-extension']) continue
    declared.add(prop.key)
    if (prop['x-originalName']) declared.add(prop['x-originalName'])
  }
  const unknown = columns.filter(c => !declared.has(c))
  if (unknown.length) {
    throw new Error(`Colonnes absentes du schéma du jeu de données éditable : ${unknown.join(', ')}. Ajoutez-les au schéma du jeu de données, ou corrigez les clés du mapping.`)
  }

  if (totalLines === 0) {
    if (drop) throw new Error('Aucune ligne n\'a été récupérée depuis l\'API : import annulé pour ne pas vider le jeu de données.')
    await log.warning('Aucune ligne n\'a été récupérée depuis l\'API : le jeu de données est laissé inchangé.')
    return
  }
  if (!drop && !dataset.primaryKey?.length) {
    await log.warning('Le jeu de données n\'a pas de clé primaire : chaque exécution ajoutera de nouvelles lignes au lieu de mettre à jour les existantes. Définissez une clé primaire sur le jeu de données, ou activez le remplacement des données.')
  }

  const formData: any = new FormData()
  formData.append('actions', fs.createReadStream(filePath), { filename })
  formData.getLength = util.promisify(formData.getLength)

  let summary: any
  try {
    summary = (await axios({
      method: 'post',
      url: `api/v1/datasets/${dataset.id}/_bulk_lines?drop=${drop}`,
      data: formData,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: { ...formData.getHeaders(), 'content-length': await formData.getLength() }
    })).data
  } catch (err) {
    throw new Error(`Le chargement des lignes a échoué : ${errorMessage(err)}`)
  }

  // _bulk_lines decides its status code when it flushes the first batch, so a later failure
  // still answers 200. The summary is the only reliable signal.
  for (const error of (summary.errors ?? []).slice(0, 10)) {
    await log.error(`ligne ${error.line} : ${error.error}`)
  }
  if (summary.cancelled) {
    throw new Error(`Le remplacement des données a été annulé par Data Fair (${summary.nbErrors} lignes en erreur), les données précédentes sont conservées.`)
  }
  if (summary.nbErrors) {
    throw new Error(`${summary.nbErrors} lignes en erreur sur ${(summary.nbOk ?? 0) + summary.nbErrors} envoyées.`)
  }

  await log.info(`jeu de donnée éditable mis à jour, id="${dataset.id}", title="${dataset.title}"`)
  await log.info(`${summary.nbCreated ?? 0} lignes créées, ${summary.nbModified ?? 0} modifiées, ${summary.nbDeleted ?? 0} supprimées, ${summary.nbNotModified ?? 0} inchangées`)
  await log.info('Toutes les données ont été envoyées')
}

export const run = async (context: ImportApiContext, noUpload = false) => {
  const { processingConfig, tmpDir, axios, log } = context
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
  let totalLines = 0
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
    await writeChunk(writeStream, stringify(lines, { header, columns, quoted: true }))
    header = false
    totalLines += lines.length
  }
  // the file has to be fully flushed before it is read back for the upload
  writeStream.end()
  await finished(writeStream)

  if (!noUpload) {
    await log.step('Chargement des données')
    const filePath = path.join(tmpDir, filename)
    const targetDataset = cfg.dataset.id ? await getTargetDataset(context, cfg.dataset.id) : null

    if (targetDataset?.isRest) {
      await uploadToEditableDataset(context, targetDataset, filePath, filename, totalLines, columns)
    } else {
      await uploadToFileDataset(context, filePath, filename)
    }

    await log.info('Suppression du fichier CSV temporaire')
    fs.unlinkSync(filePath)
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
