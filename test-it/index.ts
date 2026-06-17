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
})
