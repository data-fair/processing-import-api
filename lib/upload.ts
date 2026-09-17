import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import util from 'node:util'
import fs from 'node:fs'
import FormData from 'form-data'

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
      throw new Error(`Le jeu de données id="${datasetId}" n'existe pas, il a peut-être été supprimé.`)
    }
    throw new Error(`Impossible de lire le jeu de données id="${datasetId}" : ${errorMessage(err)}`)
  }
}

export const uploadToFileDataset = async (context: ProcessingContext<ProcessingConfig>, filePath: string, filename: string) => {
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
