const util = require('util')
const FormData = require('form-data')
const getHeaders = require('./lib/authentications')
const { getValueByPath } = require('./lib/utils')
const { stringify } = require('csv-stringify/sync')
const fs = require('node:fs')
const path = require('path')
const slugify = require('slugify')

/**
 * @param {import('./lib/types.mjs').JSONMappingProcessingContext} context
 * @param {number} offset
 * @param {any} [data]
 * @param {any[]} [lines]
 */
async function getPageUrl (context, offset, data, lines) {
  const url = context.processingConfig.apiURL
  const paginationConfig = context.processingConfig.pagination

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
    urlObj.searchParams.set(paginationConfig.offsetKey, offset + '')
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
}

const process = exports.process = function (data, block, separator, common = {}) {
  let base = {}
  if (block.mapping && block.mapping.length) {
    base = Object.assign({}, ...block.mapping.map(m => {
      const values = getValueByPath(data, m.path)
      if (values == null) return {}
      return { [m.key]: (values.constructor === Array) ? values.join(separator) : getValueByPath(data, m.path) }
    }))
  }
  if (block.expand && block.expand.path) {
    return [].concat(...getValueByPath(data, block.expand.path).map(d => process(d, block.expand.block, separator, { ...base, ...common })))
  } else return [{ ...base, ...common }]
}

const headersFromConfig = exports.headers = function (block) {
  const base = (block.mapping || []).map(m => m.key)
  if (block.expand && block.expand.path) {
    return base.concat(headersFromConfig(block.expand.block))
  } else return base
}

/**
 * @param {import('./lib/types.mjs').JSONMappingProcessingContext} context
 */
exports.run = async (context, noUpload = false) => {
  const { processingConfig, processingId, tmpDir, axios, log, patchConfig } = context

  // ------------------ Récupération, conversion et envoi des données ------------------
  await log.step('Récupération et conversion des données')
  let headers = { Accept: 'application/json' }
  if (processingConfig.auth && processingConfig.auth.authMethod !== 'noAuth') {
    if (context.secrets) {
      for (const key of ['password', 'apiKeyValue', 'clientSecret']) {
        if (processingConfig.auth[key] === '********' && context.secrets[key]) {
          processingConfig.auth[key] = context.secrets[key]
        }
      }
    }

    const authHeader = await getHeaders(processingConfig.auth, axios, log)
    headers = { ...headers, ...authHeader }
  }

  let offset = processingConfig.pagination?.offsetPages ? 1 : 0
  /** @type {string | null} */
  let nextPageURL = await getPageUrl(context, offset)
  const filename = slugify(processingConfig.dataset.title, { lower: true, strict: true }) + '.csv'
  const writeStream = fs.createWriteStream(path.join(tmpDir, filename), { flags: 'w' })
  const columns = headersFromConfig(processingConfig.block)
  let header = true
  while (nextPageURL) {
    await log.info(`Récupération de ${nextPageURL}`)
    const results = await axios({
      method: 'get',
      url: nextPageURL,
      headers,
      timeout: 10 * 60000 // very long timeout as we don't control the API and some export logic are very slow
    })
    const data = getValueByPath(results.data, processingConfig.resultsPath)
    if (!data) {
      await log.warning('Aucune donnée n\'a été récupérée')
      break
    }
    await log.info(`Conversion de ${data.length || 1} lignes`)
    const lines = [].concat(...(Array.isArray(data) ? data : [data]).map(d => process(d, processingConfig.block, processingConfig.separator)))

    if (lines.length === 0) {
      await log.warning('Aucune donnée n\'a été récupérée')
      break
    } else if (data.length > 10000) {
      await log.warning('Le nombre de lignes est trop important, privilégier une pagination plus petite.')
    }

    if (processingConfig.pagination?.offsetPages) offset++
    else offset += data.length
    nextPageURL = await getPageUrl(context, offset, results.data, (Array.isArray(data) ? data : [data]))

    await log.info(`Création de ${lines.length} lignes`)
    await writeStream.write(stringify(lines, { header, columns }))
    header = false
  }
  if (!noUpload) {
    await log.step('Chargement des données')
    const formData = new FormData()
    formData.append('title', processingConfig.dataset.title)
    formData.append('extras', JSON.stringify({ processingId }))
    formData.append('file', fs.createReadStream(path.join(tmpDir, filename)), { filename })
    formData.getLength = util.promisify(formData.getLength)

    try {
      const dataset = (await axios({
        method: 'post',
        url: 'api/v1/datasets/' + (processingConfig.dataset.id || ''),
        data: formData,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: { ...formData.getHeaders(), 'content-length': await formData.getLength() }
      })).data
      await log.info(`jeu de donnée ${processingConfig.datasetMode === 'update' ? 'mis à jour' : 'créé'}, id="${dataset.id}", title="${dataset.title}"`)
      if (processingConfig.datasetMode === 'create') {
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

/**
 * @type {import('@data-fair/lib-common-types/processings.js').PrepareFunction}
 */
exports.prepare = async (context) => {
  /** @type {Record<string, string>} */
  const secrets = {}
  const auth = context.processingConfig.auth
  for (const key of ['password', 'apiKeyValue', 'clientSecret']) {
    if (auth[key] && auth[key] !== '********' && auth[key] !== '') {
      secrets[key] = auth[key]
      auth[key] = '********'
    }
  }

  return {
    processingConfig: context.processingConfig,
    secrets
  }
}
