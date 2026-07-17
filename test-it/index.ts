import config from '#config'
import assert from 'node:assert'
import fs from 'node:fs'
import { it, describe, before, afterEach } from 'node:test'
import nock from 'nock'

import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as importApiPlugin from '../index.ts'
import { getValueByPath } from '../lib/utils.ts'

import processingConfigSchema from '../processing-config-schema.json' with { type: 'json' }
import processingConfig from './resources/processing-config.json' with { type: 'json' }
import sites from './resources/sites.json' with { type: 'json' }
import cinemas from './resources/cinemas.json' with { type: 'json' }
import sirene from './resources/sirene.json' with { type: 'json' }
import block from './resources/block.json' with { type: 'json' }

const dataFairUrl = new URL(config.dataFairUrl)
const dfOrigin = dataFairUrl.origin
const dfPath = dataFairUrl.pathname.replace(/\/$/, '')

const sireneConfig = (overrides: any = {}) => ({
  block: {
    mapping: [
      { key: 'siret', path: 'siret' },
      { key: 'denominationUniteLegale', path: 'uniteLegale.denominationUniteLegale' }
    ]
  },
  separator: ',',
  apiURL: 'https://api.insee.fr/entreprises/sirene/V3.11/siret',
  resultsPath: 'etablissements',
  datasetMode: 'update',
  dataset: { id: 'sirene-ds', title: 'Sirene' },
  ...overrides
})

const sireneContext = (processingConfig: any) => testUtils.context({
  pluginConfig: {},
  processingConfig,
  tmpDir: 'data'
}, config, false)

const nockSireneApi = () => nock('https://api.insee.fr')
  .get('/entreprises/sirene/V3.11/siret')
  .reply(200, sirene)

const restDataset = (overrides: any = {}) => ({
  id: 'sirene-ds',
  title: 'Sirene',
  isRest: true,
  primaryKey: ['siret'],
  schema: [{ key: 'siret', type: 'string' }, { key: 'denominationUniteLegale', type: 'string' }],
  ...overrides
})

describe('import-api processing', () => {
  before(() => {
    fs.mkdirSync('data', { recursive: true })
  })
  afterEach(() => {
    nock.cleanAll()
  })

  it('should expose a processing config schema for users', async () => {
    assert.equal(processingConfigSchema.type, 'object')
  })

  it('should get values by path', async () => {
    let data = getValueByPath(sites, 'sites.0.id')
    assert.equal(data, '2381912')
    data = getValueByPath(sites, 'sites.0.super_billets.0.id')
    assert.equal(data, 6)
    data = getValueByPath(sites, 'sites.0.super_billets[].id')
    assert.equal(data.join('.'), [6, 7].join('.'))
  })

  it('should flatten a block', async () => {
    const results = importApiPlugin.flattenData(cinemas, block as any, ';')
    assert.ok(results.length > 0)
  })

  it('should get headers', async () => {
    const headers = importApiPlugin.blockHeaders((processingConfig as any).block)
    assert.equal(headers.length, 10)
  })

  it('should create a dataset from a public API without pagination', async function () {
    const scope = nock('https://test.com')
      .get('/api/items')
      .reply(200, sites)

    const context = testUtils.context({
      pluginConfig: {},
      processingConfig,
      tmpDir: 'data'
    }, config, false)
    await importApiPlugin.run(context, true)
    assert.ok(scope.isDone())
  })

  it('should create a dataset from the sirene API without uploading', async function () {
    const scope = nock('https://api.insee.fr')
      .get('/entreprises/sirene/V3.11/siret')
      .reply(200, sirene)

    const context = testUtils.context({
      pluginConfig: {},
      processingConfig: {
        block: {
          mapping: [
            {
              key: 'siret',
              path: 'siret'
            },
            {
              key: 'denominationUniteLegale',
              path: 'uniteLegale.denominationUniteLegale'
            }
          ]
        },
        separator: ',',
        apiURL: 'https://api.insee.fr/entreprises/sirene/V3.11/siret',
        resultsPath: 'etablissements',
        datasetMode: 'create',
        dataset: { title: 'Sirene' }
      },
      tmpDir: 'data'
    }, config, false)
    await importApiPlugin.run(context, true)
    assert.ok(scope.isDone())
  })

  it('should send lines to an editable dataset through _bulk_lines, never as a file', async function () {
    const apiScope = nockSireneApi()
    const dfScope = nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(200, restDataset())
      .post(`${dfPath}/api/v1/datasets/sirene-ds/_bulk_lines`)
      .query({ drop: 'false' })
      .reply(200, { nbOk: 20, nbErrors: 0, nbCreated: 20, nbModified: 0, nbDeleted: 0, nbNotModified: 0 })

    await importApiPlugin.run(sireneContext(sireneConfig()))

    assert.ok(apiScope.isDone())
    // a pending mock here would mean the file route was taken instead of _bulk_lines
    assert.ok(dfScope.isDone(), 'le jeu éditable doit être alimenté via _bulk_lines')
  })

  it('should pass drop=true and refuse to empty an editable dataset when the API returns nothing', async function () {
    nock('https://api.insee.fr')
      .get('/entreprises/sirene/V3.11/siret')
      .reply(200, { etablissements: [] })
    nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(200, restDataset())

    await assert.rejects(
      importApiPlugin.run(sireneContext(sireneConfig({ drop: true }))),
      /import annulé pour ne pas vider le jeu de données/
    )
  })

  it('should fail when _bulk_lines reports errors, even on a 200 response', async function () {
    nockSireneApi()
    nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(200, restDataset())
      .post(`${dfPath}/api/v1/datasets/sirene-ds/_bulk_lines`)
      .query({ drop: 'false' })
      .reply(200, { nbOk: 18, nbErrors: 2, errors: [{ line: 3, error: 'valeur invalide' }] })

    await assert.rejects(
      importApiPlugin.run(sireneContext(sireneConfig())),
      /2 lignes en erreur sur 20/
    )
  })

  it('should fail when a drop is cancelled by data-fair', async function () {
    nockSireneApi()
    nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(200, restDataset())
      .post(`${dfPath}/api/v1/datasets/sirene-ds/_bulk_lines`)
      .query({ drop: 'true' })
      .reply(200, { nbOk: 0, nbErrors: 1, cancelled: true, errors: [] })

    await assert.rejects(
      importApiPlugin.run(sireneContext(sireneConfig({ drop: true }))),
      /annulé par Data Fair.*données précédentes sont conservées/
    )
  })

  it('should reject columns missing from the editable dataset schema before uploading', async function () {
    nockSireneApi()
    nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(200, restDataset({ schema: [{ key: 'siret', type: 'string' }] }))

    await assert.rejects(
      importApiPlugin.run(sireneContext(sireneConfig())),
      /Colonnes absentes du schéma.*denominationUniteLegale/
    )
  })

  it('should surface the reason data-fair rejected a file upload', async function () {
    nockSireneApi()
    nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(200, { id: 'sirene-ds', title: 'Sirene', file: { name: 'sirene.csv' } })
      .post(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(400, 'this dataset is not file based')

    await assert.rejects(
      importApiPlugin.run(sireneContext(sireneConfig())),
      /Le chargement du fichier a échoué.*this dataset is not file based/
    )
  })
})
