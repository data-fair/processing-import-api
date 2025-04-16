process.env.NODE_ENV = 'test'

const nock = require('nock')
const config = require('config')
const assert = require('node:assert').strict
const processing = require('../')
const sites = require('./sites.json')
const { getValueByPath } = require('../lib/utils')
const processingConfig = require('./processing-config.json')
const title = processingConfig.dataset.title
const block = require('./block.json')
const cinemas = require('./cinemas.json')

describe('test', function () {
  it('should expose a plugin config schema for super admins', async () => {
    const schema = require('../plugin-config-schema.json')
    assert.ok(schema)
  })

  it('should expose a processing config schema for users', async () => {
    const schema = require('../processing-config-schema.json')
    assert.equal(schema.type, 'object')
  })

  it('should get values by path', async () => {
    let data = getValueByPath(sites, 'sites.0.id')
    assert.equal(data, '2381912')
    data = getValueByPath(sites, 'sites.0.super_billets.0.id')
    assert.equal(data, 6)
    data = getValueByPath(sites, 'sites.0.super_billets[].id')
    assert.equal(data.join('.'), [6, 7].join('.'))
    // data = getValueByPath(sites, 'sites.0.events[].sessions')
    // console.log(data)
  })

  it('should process a block', async () => {
    const results = processing.process(cinemas, block, ';')
    console.log(results.length)
  })

  it('should get headers', async () => {
    const headers = processing.headers(processingConfig.block)
    assert.equal(headers.length, 10)
  })

  it('should create a dataset from a public API without pagination', async function () {
    const scope = nock('https://test.com')
      .get('/api/items')
      .reply(200, sites)

    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    const context = testsUtils.context({
      pluginConfig: {},
      processingConfig,
      tmpDir: 'data'
    }, config, true)
    await processing.run(context)
    assert.ok(scope.isDone())

    assert.equal(context.processingConfig.datasetMode, 'update')
    assert.equal(context.processingConfig.dataset.title, title)
    const datasetId = context.processingConfig.dataset.id
    try {
      await context.ws.waitForJournal(datasetId, 'finalize-end')
      const dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
      assert.equal(dataset.schema.filter(p => !p['x-calculated']).length, 10)
      assert.equal(dataset.count, 1196)
    } finally {
      await context.axios.delete(`api/v1/datasets/${datasetId}`)
    }
  })

  it('should create a dataset from a public API without pagination', async function () {
    const scope = nock('https://api.insee.fr')
      .get('/entreprises/sirene/V3.11/siret')
      .reply(200, require('./sirene.json'))

    const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
    const context = testsUtils.context({
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
    }, config, true)
    await processing.run(context, true)
    assert.ok(scope.isDone())
  })

  // it.skip('should use oauth connection to insee API', async function () {
  //   this.timeout(1000000)

  //   const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')

  //   const context = testsUtils.context({
  //     pluginConfig: {},
  //     processingConfig: {
  //       datasetMode: 'create',
  //       dataset: { title: 'Json mapping test' },
  //       apiURL: 'https://api.insee.fr/metadonnees/V1/concepts/definitions',
  //       resultPath: '',
  //       detectSchema: true,
  //       // auth: {
  //       //   authMethod: 'bearerAuth',
  //       //   token: config.inseeToken
  //       // },
  //       auth: {
  //         authMethod: 'apiKey',
  //         apiKeyHeader: 'Authorization',
  //         apiKeyValue: `Bearer ${config.inseeToken}`
  //       },
  //       // auth: {
  //       //   authMethod: 'oauth2',
  //       //   grantType: 'client_credentials',
  //       //   tokenURL: 'https://api.insee.fr/token',
  //       //   clientId: config.inseeClientId,
  //       //   clientSecret: config.inseeClientSecret
  //       // },
  //       clearFile: false
  //     },
  //     tmpDir: 'data'
  //   }, config, true)

  //   await processing.run(context)
  // })

  // it('should create a dataset from a public API, detect the schema, perform a simple pagination', async function () {
  //   const scope = nock('https://test.com')
  //     .get('/api/items')
  //     .reply(200, {
  //       data: [
  //         { id: 1, name: 'item1', price: 10 },
  //         { id: 2, name: 'item2', price: 20 }
  //       ],
  //       next_page: 'https://test.com/api/items?page=2'
  //     })
  //     .get('/api/items?page=2')
  //     .reply(200, {
  //       data: [
  //         { id: 3, name: 'item3', price: 30 }
  //       ]
  //     })

  //   const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
  //   const context = testsUtils.context({
  //     pluginConfig: {},
  //     processingConfig: {
  //       datasetMode: 'create',
  //       dataset: { title: 'processing-import-api test simple' },
  //       apiURL: 'https://test.com/api/items',
  //       resultPath: 'data',
  //       pagination: {
  //         method: 'nextPageData'
  //       },
  //       detectSchema: true
  //     },
  //     tmpDir: 'data'
  //   }, config, true)
  //   await processing.run(context)
  //   assert.ok(scope.isDone())

  //   assert.equal(context.processingConfig.datasetMode, 'update')
  //   assert.equal(context.processingConfig.dataset.title, 'processing-import-api test simple')
  //   const datasetId = context.processingConfig.dataset.id

  //   try {
  //     await context.ws.waitForJournal(datasetId, 'finalize-end')
  //     let dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
  //     assert.equal(dataset.schema.filter(p => !p['x-calculated']).length, 3)
  //     assert.equal(dataset.count, 3)

  //     const scope2 = nock('https://test.com')
  //       .get('/api/items')
  //       .reply(200, {
  //         data: [
  //           { id: 4, name: 'item4', price: 40 }
  //         ]
  //       })
  //     await processing.run(context)
  //     assert.ok(scope2.isDone())

  //     await context.ws.waitForJournal(datasetId, 'finalize-end')

  //     dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
  //     assert.equal(dataset.count, 4)
  //   } finally {
  //     await context.axios.delete(`api/v1/datasets/${datasetId}`)
  //   }
  // })

  // it('should perform a pagination based on offset parameter', async function () {
  //   const scope = nock('https://test.com')
  //     .get('/api/items?offset=0&limit=2')
  //     .reply(200, {
  //       data: [
  //         { id: 1, name: 'item1', price: 10 },
  //         { id: 2, name: 'item2', price: 20 }
  //       ],
  //       next_page: 'https://test.com/api/items?offset=2&limit=2'
  //     })
  //     .get('/api/items?offset=2&limit=2')
  //     .reply(200, {
  //       data: [
  //         { id: 3, name: 'item3', price: 30 }
  //       ]
  //     })

  //   const testsUtils = await import('@data-fair/lib/processings/tests-utils.js')
  //   const context = testsUtils.context({
  //     pluginConfig: {},
  //     processingConfig: {
  //       datasetMode: 'create',
  //       dataset: { title: 'processing-import-api test offset page' },
  //       apiURL: 'https://test.com/api/items',
  //       resultPath: 'data',
  //       pagination: {
  //         method: 'queryParams',
  //         offsetKey: 'offset',
  //         limitKey: 'limit',
  //         limitValue: 2
  //       },
  //       detectSchema: true
  //     },
  //     tmpDir: 'data'
  //   }, config, true)
  //   await processing.run(context)
  //   assert.ok(scope.isDone())

  //   assert.equal(context.processingConfig.datasetMode, 'update')
  //   assert.equal(context.processingConfig.dataset.title, 'processing-import-api test offset page')
  //   const datasetId = context.processingConfig.dataset.id

  //   try {
  //     await context.ws.waitForJournal(datasetId, 'finalize-end')
  //     let dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
  //     assert.equal(dataset.schema.filter(p => !p['x-calculated']).length, 3)
  //     assert.equal(dataset.count, 3)

  //     const scope2 = nock('https://test.com')
  //       .get('/api/items?offset=0&limit=2')
  //       .reply(200, {
  //         data: [
  //           { id: 4, name: 'item4', price: 40 }
  //         ]
  //       })
  //     await processing.run(context)
  //     assert.ok(scope2.isDone())

  //     await context.ws.waitForJournal(datasetId, 'finalize-end')

  //     dataset = (await context.axios.get(`api/v1/datasets/${datasetId}`)).data
  //     assert.equal(dataset.count, 4)
  //   } finally {
  //     await context.axios.delete(`api/v1/datasets/${datasetId}`)
  //   }
  // })
})
