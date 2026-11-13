import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import util from 'node:util'
import fs from 'node:fs'
import FormData from 'form-data'
import { dfRetry } from './utils.ts'

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
 * Read the target dataset to route the upload. An editable dataset only accepts lines through
 * _bulk_lines: Data Fair rejects a file posted on it with "this dataset is not file based".
 */
export const getTargetDataset = async (context: ProcessingContext<ProcessingConfig>, datasetId: string) => {
  try {
    return (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
  } catch (err: any) {
    if (errorStatus(err) === 404) {
      throw new Error(`The dataset id="${datasetId}" does not exist, it may have been deleted.`)
    }
    throw new Error(`Failed to read the dataset id="${datasetId}": ${errorMessage(err)}`)
  }
}

/**
 * Title of the dataset to create. Processings saved before the flat `datasetTitle` field
 * carried it in `dataset.title`.
 */
export const datasetTitle = (cfg: any): string => cfg.datasetTitle || cfg.dataset?.title

/**
 * Create an empty editable dataset carrying the columns of the mapping. Data Fair validates
 * every line of an editable dataset strictly against its schema and never infers it, so the
 * columns have to be declared here; they are all created as strings, the types and the primary
 * key are adjusted afterwards in the dataset schema.
 */
export const createEditableDataset = async (context: ProcessingContext<ProcessingConfig>, columns: string[]) => {
  const { processingConfig, processingId, axios, log, patchConfig } = context
  const cfg = processingConfig as any

  let dataset
  try {
    dataset = (await dfRetry(() => axios.post('api/v1/datasets', {
      title: datasetTitle(cfg),
      isRest: true,
      schema: columns.map(key => ({ key, type: 'string' })),
      extras: { processingId }
    }), log)).data
  } catch (err) {
    throw new Error(`Failed to create the editable dataset: ${errorMessage(err)}`)
  }

  await log.info(`Editable dataset created, id="${dataset.id}", title="${dataset.title}"`)
  await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title, isRest: true } })
  return dataset
}

export const uploadToFileDataset = async (context: ProcessingContext<ProcessingConfig>, filePath: string, filename: string) => {
  const { processingConfig, processingId, axios, log, patchConfig } = context
  const cfg = processingConfig as any

  let dataset
  try {
    // the multipart body streams the file, it is rebuilt on each attempt
    dataset = (await dfRetry(async () => {
      const formData: any = new FormData()
      formData.append('title', datasetTitle(cfg))
      formData.append('extras', JSON.stringify({ processingId }))
      formData.append('file', fs.createReadStream(filePath), { filename })
      formData.getLength = util.promisify(formData.getLength)
      return axios({
        method: 'post',
        url: 'api/v1/datasets/' + (cfg.dataset?.id || ''),
        data: formData,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: { ...formData.getHeaders(), 'content-length': await formData.getLength() }
      })
    }, log)).data
  } catch (err) {
    throw new Error(`Failed to upload the file: ${errorMessage(err)}`)
  }

  await log.info(`Dataset ${cfg.datasetMode === 'update' ? 'updated' : 'created'}, id="${dataset.id}", title="${dataset.title}"`)
  if (cfg.datasetMode === 'create') {
    await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title, isRest: false } })
  }
  await log.info('All the data was uploaded')
}

/**
 * An editable dataset takes the very CSV we already produced, as a multipart "actions" part.
 * _bulk_lines never derives the schema from the data, so columns the dataset doesn't declare
 * would make Data Fair reject the whole stream: check them first to fail with a message that
 * says what to fix.
 */
export const uploadToEditableDataset = async (
  context: ProcessingContext<ProcessingConfig>,
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
    throw new Error(`Columns missing from the schema of the editable dataset: ${unknown.join(', ')}. Add them to the dataset schema, or fix the keys of the mapping.`)
  }

  if (totalLines === 0) {
    if (drop) throw new Error('No row was fetched from the API: import cancelled so as not to empty the dataset.')
    await log.warning('No row was fetched from the API: the dataset is left unchanged.')
    return
  }
  if (!drop && !dataset.primaryKey?.length) {
    await log.warning('The dataset has no primary key: each run will add new rows instead of updating the existing ones. Define a primary key on the dataset, or enable the data replacement.')
  }

  let summary: any
  try {
    // the multipart body streams the file, it is rebuilt on each attempt
    summary = (await dfRetry(async () => {
      const formData: any = new FormData()
      formData.append('actions', fs.createReadStream(filePath), { filename })
      formData.getLength = util.promisify(formData.getLength)
      return axios({
        method: 'post',
        url: `api/v1/datasets/${dataset.id}/_bulk_lines?drop=${drop}`,
        data: formData,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: { ...formData.getHeaders(), 'content-length': await formData.getLength() }
      })
    }, log)).data
  } catch (err) {
    throw new Error(`Failed to upload the rows: ${errorMessage(err)}`)
  }

  // _bulk_lines decides its status code when it flushes the first batch, so a later failure
  // still answers 200. The summary is the only reliable signal.
  for (const error of (summary.errors ?? []).slice(0, 10)) {
    await log.error(`Row ${error.line}: ${error.error}`)
  }
  if (summary.cancelled) {
    throw new Error(`Data Fair cancelled the data replacement (${summary.nbErrors} rows in error), the previous data is kept.`)
  }
  if (summary.nbErrors) {
    throw new Error(`${summary.nbErrors} rows in error out of ${(summary.nbOk ?? 0) + summary.nbErrors} sent.`)
  }

  await log.info(`Editable dataset updated, id="${dataset.id}", title="${dataset.title}"`)
  await log.info(`${summary.nbCreated ?? 0} rows created, ${summary.nbModified ?? 0} modified, ${summary.nbDeleted ?? 0} deleted, ${summary.nbNotModified ?? 0} unchanged`)
  await log.info('All the data was uploaded')
}
