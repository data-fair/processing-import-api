import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import slugify from 'slugify'
import { stringify } from 'csv-stringify/sync'
import getAuthHeaders from './authentications.ts'
import { secretKeys } from './prepare.ts'
import { getPageUrl } from './pagination.ts'
import { flattenData, blockHeaders } from './flatten.ts'
import { getTargetDataset, uploadToFileDataset, uploadToEditableDataset } from './upload.ts'
import { getValueByPath } from './utils.ts'

/**
 * True when an interruption is requested: the page loop ends and nothing is uploaded.
 * Set by `stop`, reset at the start of each run.
 */
let shouldBeStopped = false

export const stop = async (): Promise<void> => { shouldBeStopped = true }

/**
 * Write to a stream while honouring backpressure, so that large exports don't pile up in memory.
 */
const writeChunk = (stream: fs.WriteStream, chunk: string): Promise<void> => {
  if (stream.write(chunk)) return Promise.resolve()
  return new Promise((resolve) => stream.once('drain', resolve))
}

/**
 * `noUpload` is a test convenience: fetch and convert without touching Data Fair.
 */
export const run = async (context: ProcessingContext<ProcessingConfig>, noUpload = false) => {
  shouldBeStopped = false
  const { processingConfig, tmpDir, axios, log } = context
  const cfg = processingConfig as any

  // ------------------ Récupération, conversion et envoi des données ------------------
  await log.step('Récupération et conversion des données')
  let headers: Record<string, string> = { Accept: 'application/json' }
  if (cfg.auth && cfg.auth.authMethod !== 'noAuth') {
    if (context.secrets) {
      for (const key of secretKeys) {
        if (cfg.auth[key] === '********' && context.secrets[key]) {
          cfg.auth[key] = context.secrets[key]
        }
      }
    }

    const authHeader = await getAuthHeaders(cfg.auth, axios, log)
    headers = { ...headers, ...authHeader }
  }

  let offset = cfg.pagination?.offsetPages ? 1 : 0
  let nextPageURL: string | null = await getPageUrl(context, offset)
  const filename = slugify(cfg.dataset.title, { lower: true, strict: true }) + '.csv'
  const writeStream = fs.createWriteStream(path.join(tmpDir, filename), { flags: 'w' })
  const columns = blockHeaders(cfg.block)
  let header = true
  let totalLines = 0
  let pages = 0
  let warnedLargePage = false
  let previousPage: string | undefined
  // The run log is stored whole in the run document, so a paginated import must not write
  // one entry per page: thousands of pages with a long URL each would overflow it. The API is
  // named once, the pages update a single progress entry, and the URLs only go to debug.
  await log.info(`Récupération de ${cfg.apiURL}`)
  const paginated = !!cfg.pagination && cfg.pagination.method !== 'none'
  const pagesTask = 'Récupération des données'
  if (paginated) await log.task(pagesTask)
  while (nextPageURL) {
    if (shouldBeStopped) break
    await log.debug(`Récupération de ${nextPageURL}`)
    const results = await axios({
      method: 'get',
      url: nextPageURL,
      headers,
      timeout: 10 * 60000 // very long timeout as we don't control the API and some export logic are very slow
    })
    const data = getValueByPath(results.data, cfg.resultsPath)
    if (!data) break
    if (paginated) {
      // An API that ignores the pagination parameter answers the same page forever
      const page = createHash('sha1').update(JSON.stringify(data)).digest('hex')
      if (page === previousPage) {
        throw new Error(`L'API a renvoyé deux fois la même page (${nextPageURL}) : la pagination est probablement mal configurée, vérifiez que l'API prend bien en compte le paramètre d'offset ou de page suivante.`)
      }
      previousPage = page
      if (!Array.isArray(data) && pages === 0) {
        await log.warning(`Le « Chemin des résultats » (${cfg.resultsPath ? `« ${cfg.resultsPath} »` : 'vide'}) ne désigne pas un tableau : la réponse est traitée comme une ligne unique et la pagination s'arrête.`)
      }
    }
    const lines = ([] as Array<Record<string, any>>).concat(...(Array.isArray(data) ? data : [data]).map((d: any) => flattenData(d, cfg.block, cfg.separator)))

    if (lines.length === 0) break
    if (data.length > 10000 && !warnedLargePage) {
      await log.warning('Le nombre de lignes est trop important, privilégier une pagination plus petite.')
      warnedLargePage = true
    }

    if (cfg.pagination?.offsetPages) offset++
    else offset += data.length
    nextPageURL = await getPageUrl(context, offset, results.data, (Array.isArray(data) ? data : [data]))

    await writeChunk(writeStream, stringify(lines, { header, columns, quoted: true }))
    header = false
    totalLines += lines.length
    pages++
    if (paginated) await log.progress(pagesTask, totalLines, 0)
  }
  // close the progress entry, the UI keeps an indeterminate bar while total is unknown
  if (paginated && totalLines > 0) await log.progress(pagesTask, totalLines, totalLines)
  if (totalLines === 0) await log.warning('Aucune donnée n\'a été récupérée')
  else await log.info(`${pages} page${pages > 1 ? 's' : ''} récupérée${pages > 1 ? 's' : ''}, ${totalLines} ligne${totalLines > 1 ? 's' : ''} convertie${totalLines > 1 ? 's' : ''}`)
  // the file has to be fully flushed before it is read back for the upload
  writeStream.end()
  await finished(writeStream)
  const filePath = path.join(tmpDir, filename)

  // A stopped run must never publish a truncated dataset
  if (shouldBeStopped) {
    await log.warning('Traitement interrompu : les données récupérées ne sont pas envoyées.')
    fs.unlinkSync(filePath)
    return
  }

  if (!noUpload) {
    await log.step('Chargement des données')
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
