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
import { getPageUrl, isSameOrigin } from './pagination.ts'
import { flattenData, blockHeaders } from './flatten.ts'
import { getTargetDataset, createEditableDataset, uploadToFileDataset, uploadToEditableDataset, datasetTitle } from './upload.ts'
import { getValueByPath, externalRequestOptions, requestTimeoutMs, isRequestTimeout } from './utils.ts'

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

  // ------------------ Fetch, convert and upload the data ------------------
  await log.step('Fetch and convert the data')
  const publicHeaders: Record<string, string> = { Accept: 'application/json' }
  let headers = publicHeaders
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
  const filename = slugify(datasetTitle(cfg), { lower: true, strict: true }) + '.csv'
  const writeStream = fs.createWriteStream(path.join(tmpDir, filename), { flags: 'w' })
  const columns = blockHeaders(cfg.block)
  let header = true
  let totalLines = 0
  let pages = 0
  let warnedLargePage = false
  let warnedOtherOrigin = false
  let previousPage: string | undefined
  // The run log is stored whole in the run document, so a paginated import must not write
  // one entry per page: thousands of pages with a long URL each would overflow it. The API is
  // named once, the pages update a single progress entry, and the URLs only go to debug.
  await log.info(`Fetch ${cfg.apiURL}`)
  const paginated = !!cfg.pagination && cfg.pagination.method !== 'none'
  const timeout = requestTimeoutMs(cfg.requestTimeout)
  const pagesTask = 'Fetched rows'
  if (paginated) await log.task(pagesTask)
  while (nextPageURL) {
    if (shouldBeStopped) break
    await log.debug(`Fetch ${nextPageURL}`)
    const sameOrigin = isSameOrigin(nextPageURL, cfg.apiURL)
    if (!sameOrigin && headers !== publicHeaders && !warnedOtherOrigin) {
      await log.warning(`The next page is on another origin than the API (${nextPageURL}): it is fetched without the authentication credentials.`)
      warnedOtherOrigin = true
    }
    const pageHeaders = sameOrigin ? headers : publicHeaders
    let results
    try {
      results = await axios({
        method: 'get',
        url: nextPageURL,
        headers: pageHeaders,
        ...externalRequestOptions(nextPageURL, Object.keys(pageHeaders).filter(h => h !== 'Accept')),
        // long by default as we don't control the API and some exports are very slow to compute
        timeout
      })
    } catch (err) {
      if (!isRequestTimeout(err)) throw err
      const minutes = timeout / 60000
      throw new Error(`The API did not answer within ${minutes} minute${minutes === 1 ? '' : 's'}. If it is only slow, raise "Request timeout (minutes)" in the "Data source" tab of the processing; with pagination, a smaller page size also shortens each request.`, { cause: err })
    }
    const data = getValueByPath(results.data, cfg.resultsPath)
    if (!data) break
    if (paginated) {
      // An API that ignores the pagination parameter answers the same page forever
      const page = createHash('sha1').update(JSON.stringify(data)).digest('hex')
      if (page === previousPage) {
        throw new Error(`The API returned the same page twice (${nextPageURL}): the pagination is probably misconfigured, check that the API takes the offset or next page parameter into account.`)
      }
      previousPage = page
      if (!Array.isArray(data) && pages === 0) {
        await log.warning(`The results array path (${cfg.resultsPath ? `"${cfg.resultsPath}"` : 'empty'}) does not point to an array: the response is handled as a single row and the pagination stops.`)
      }
    }
    // flatMap rather than concat(...spread): spreading a page of 100k+ items overflows the call stack
    const lines = (Array.isArray(data) ? data : [data]).flatMap((d: any) => flattenData(d, cfg.block, cfg.separator))

    if (lines.length === 0) break
    if (data.length > 10000 && !warnedLargePage) {
      await log.warning(`A page holds ${data.length} items: prefer a smaller page size to limit the memory used.`)
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
  if (totalLines === 0) await log.warning('No data was fetched')
  else await log.info(`${pages} page${pages > 1 ? 's' : ''} fetched, ${totalLines} row${totalLines > 1 ? 's' : ''} converted`)
  // the file has to be fully flushed before it is read back for the upload
  writeStream.end()
  await finished(writeStream)
  const filePath = path.join(tmpDir, filename)

  // A stopped run must never publish a truncated dataset
  if (shouldBeStopped) {
    await log.warning('Processing stopped: the fetched data is not uploaded.')
    fs.unlinkSync(filePath)
    return
  }

  if (!noUpload) {
    await log.step('Upload the data')
    let targetDataset = cfg.dataset?.id ? await getTargetDataset(context, cfg.dataset.id) : null
    if (!targetDataset && cfg.editableCreate) targetDataset = await createEditableDataset(context, columns)

    if (targetDataset?.isRest) {
      await uploadToEditableDataset(context, targetDataset, filePath, filename, totalLines, columns)
    } else {
      await uploadToFileDataset(context, filePath, filename)
    }

    await log.info('Delete the temporary CSV file')
    fs.unlinkSync(filePath)
  }
}
