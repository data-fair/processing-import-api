import config from '#config'
import assert from 'node:assert'
import fs from 'node:fs'
import { it, describe, before, afterEach } from 'node:test'
import axios from 'axios'
import nock from 'nock'

import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as importApiPlugin from '../index.ts'
import { run, stop } from '../lib/execute.ts'
import { flattenData, blockHeaders } from '../lib/flatten.ts'
import { getValueByPath, externalRequestOptions, dfRetry } from '../lib/utils.ts'
import getAuthHeaders from '../lib/authentications.ts'

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

/**
 * Spy on every log function of a context, keeping the original behaviour.
 */
const recordLog = (context: any) => {
  const entries: Array<{ type: string, msg: string, progress?: number, total?: number }> = []
  for (const type of ['step', 'info', 'warning', 'error', 'debug', 'task'] as const) {
    const original = context.log[type]
    context.log[type] = async (msg: string, extra?: any) => { entries.push({ type, msg }); await original(msg, extra) }
  }
  const originalProgress = context.log.progress
  context.log.progress = async (msg: string, progress: number, total: number) => { entries.push({ type: 'progress', msg, progress, total }); await originalProgress(msg, progress, total) }
  return entries
}

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

  it('should expose prepare, run and stop', async () => {
    assert.equal(typeof importApiPlugin.prepare, 'function')
    assert.equal(typeof importApiPlugin.run, 'function')
    assert.equal(typeof importApiPlugin.stop, 'function')
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
    const results = flattenData(cinemas, block as any, ';')
    assert.ok(results.length > 0)
  })

  it('should get headers', async () => {
    const headers = blockHeaders((processingConfig as any).block)
    assert.equal(headers.length, 10)
  })

  describe('session authentication', () => {
    const silentLog = { debug: async () => {}, error: async () => {} } as any

    it('should log in with a JSON body and send the token in a custom header (Parkki style)', async () => {
      const scope = nock('https://client.parkki.io')
        .post('/v2.4/auth/app', { app_id: 'my-app', api_key: 'my-key' })
        .reply(200, { access_token: { token: 'jwt-access', expires_at: 1 }, refresh_token: { token: 'jwt-refresh', expires_at: 2 } })
      const headers = await getAuthHeaders({
        authMethod: 'session',
        loginURL: 'https://client.parkki.io/v2.4/auth/app',
        loginMethod: 'POST',
        username: 'my-app',
        password: 'my-key',
        usernameField: 'app_id',
        passwordField: 'api_key',
        tokenPath: 'access_token.token',
        tokenHeader: 'X-Access-Token'
      }, axios, silentLog)
      assert.ok(scope.isDone())
      assert.deepEqual(headers, { 'X-Access-Token': 'jwt-access' })
    })

    it('should keep the GLPI behaviour on a config without the new fields', async () => {
      const scope = nock('https://glpi.test', { reqheaders: { authorization: 'Basic ' + Buffer.from('user:pass').toString('base64'), 'app-token': 'app-tok' } })
        .get('/apirest.php/initSession')
        .reply(200, { session_token: 'sess-tok' })
      const headers = await getAuthHeaders({
        authMethod: 'session',
        loginURL: 'https://glpi.test/apirest.php/initSession',
        username: 'user',
        password: 'pass',
        tokenApp: 'app-tok'
      }, axios, silentLog)
      assert.ok(scope.isDone())
      assert.deepEqual(headers, { 'Session-Token': 'sess-tok', 'App-Token': 'app-tok' })
    })

    it('should fail clearly when the token is not found at the configured path', async () => {
      nock('https://client.parkki.io').post('/v2.4/auth/app').reply(200, { access_token: { token: 'jwt' } })
      await assert.rejects(getAuthHeaders({
        authMethod: 'session',
        loginURL: 'https://client.parkki.io/v2.4/auth/app',
        loginMethod: 'POST',
        username: 'a',
        password: 'b',
        usernameField: 'app_id',
        passwordField: 'api_key',
        tokenPath: 'token'
      }, axios, silentLog), /token/)
    })
    it('should run a full import with the session token read from the secrets', async () => {
      const login = nock('https://client.parkki.io')
        .post('/v2.4/auth/app', { app_id: 'my-app', api_key: 'my-key' })
        .reply(200, { access_token: { token: 'jwt-access' } })
      const data = nock('https://client.parkki.io', { reqheaders: { 'x-access-token': 'jwt-access' } })
        .get('/v2.4/iot/displays?contract_id=42')
        .reply(200, { displays: [{ name: 'P+R Avenir', meta_data: { computed_value: 'OUVERT' } }] })
      const context = testUtils.context({
        pluginConfig: {},
        processingConfig: {
          block: { mapping: [{ key: 'NOM_PR', path: 'name' }, { key: 'ETAT_PR', path: 'meta_data.computed_value' }] },
          separator: ';',
          apiURL: 'https://client.parkki.io/v2.4/iot/displays?contract_id=42',
          resultsPath: 'displays',
          datasetMode: 'create',
          dataset: { title: 'Parkki' },
          auth: {
            authMethod: 'session',
            loginURL: 'https://client.parkki.io/v2.4/auth/app',
            loginMethod: 'POST',
            username: 'my-app',
            password: '********',
            usernameField: 'app_id',
            passwordField: 'api_key',
            tokenPath: 'access_token.token',
            tokenHeader: 'X-Access-Token'
          }
        },
        secrets: { password: 'my-key' },
        tmpDir: 'data'
      }, config, false)
      await run(context, true)
      assert.ok(login.isDone())
      assert.ok(data.isDone())
    })
  })

  it('should send username and password on an OAuth2 password grant', async () => {
    const scope = nock('https://oauth.test')
      .post('/token', (body) => body.grant_type === 'password_credentials' && body.username === 'u' && body.password === 'p')
      .reply(200, { access_token: 'tok' })
    const headers = await getAuthHeaders({
      authMethod: 'oauth2',
      grantType: 'password_credentials',
      tokenURL: 'https://oauth.test/token',
      clientId: 'c',
      clientSecret: 's',
      username: 'u',
      password: 'p'
    }, axios, { debug: async () => {}, error: async () => {} } as any)
    assert.ok(scope.isDone())
    assert.equal(headers.Authorization, 'Bearer tok')
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
    await run(context, true)
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
    await run(context, true)
    assert.ok(scope.isDone())
  })

  it('should report the pagination as a single progress task instead of one log per page', async function () {
    const page = (start: number) => ({ etablissements: sirene.etablissements.slice(start, start + 2) })
    const apiScope = nock('https://api.insee.fr')
      .get('/entreprises/sirene/V3.11/siret').query({ nombre: '2', debut: '0' }).reply(200, page(0))
      .get('/entreprises/sirene/V3.11/siret').query({ nombre: '2', debut: '2' }).reply(200, page(2))
      .get('/entreprises/sirene/V3.11/siret').query({ nombre: '2', debut: '4' }).reply(200, page(4))
      .get('/entreprises/sirene/V3.11/siret').query({ nombre: '2', debut: '6' }).reply(200, { etablissements: [] })

    const context = sireneContext(sireneConfig({
      pagination: { method: 'queryParams', limitKey: 'nombre', limitValue: 2, offsetKey: 'debut' }
    }))
    const entries = recordLog(context)

    await run(context, true)
    assert.ok(apiScope.isDone())

    // the API is named once, and the pages go through the progress of a single task
    const infos = entries.filter(e => e.type === 'info')
    assert.deepStrictEqual(infos.filter(e => e.msg.startsWith('Fetch ')).map(e => e.msg), ['Fetch https://api.insee.fr/entreprises/sirene/V3.11/siret'])
    assert.strictEqual(entries.filter(e => e.type === 'task').length, 1)
    const taskName = entries.find(e => e.type === 'task')!.msg
    assert.deepStrictEqual(entries.filter(e => e.type === 'progress').map(e => [e.msg, e.progress, e.total]), [[taskName, 2, 0], [taskName, 4, 0], [taskName, 6, 0], [taskName, 6, 6]])
    // nothing else is written per page, only the final summary
    assert.strictEqual(infos.length, 2)
    assert.match(infos[1].msg, /^3 pages fetched, 6 rows converted$/)
    assert.strictEqual(entries.filter(e => e.type === 'warning').length, 0)
  })

  it('should fail when the API keeps returning the same page (pagination parameter ignored)', async function () {
    const page = { etablissements: sirene.etablissements.slice(0, 2) }
    const apiScope = nock('https://api.insee.fr')
      .get('/entreprises/sirene/V3.11/siret').query({ nombre: '2', debut: '0' }).reply(200, page)
      .get('/entreprises/sirene/V3.11/siret').query({ nombre: '2', debut: '2' }).reply(200, page)

    const context = sireneContext(sireneConfig({
      pagination: { method: 'queryParams', limitKey: 'nombre', limitValue: 2, offsetKey: 'debut' }
    }))
    await assert.rejects(run(context, true), /same page twice/)
    assert.ok(apiScope.isDone())
  })

  it('should not send the credentials to a next page link on another origin', async function () {
    const apiScope = nock('https://api.insee.fr', { reqheaders: { authorization: 'Bearer secret' } })
      .get('/entreprises/sirene/V3.11/siret').reply(200, { etablissements: sirene.etablissements.slice(0, 2), next: '/entreprises/sirene/V3.11/siret?page=2' })
      .get('/entreprises/sirene/V3.11/siret').query({ page: '2' }).reply(200, { etablissements: sirene.etablissements.slice(2, 4), next: 'https://evil.example.com/steal' })
    const evilScope = nock('https://evil.example.com', { badheaders: ['authorization'] })
      .get('/steal').reply(200, { etablissements: [] })

    const context = sireneContext(sireneConfig({
      auth: { authMethod: 'bearerAuth', token: 'secret' },
      pagination: { method: 'nextPageData', nextPagePath: 'next' }
    }))
    const entries = recordLog(context)
    await run(context, true)
    assert.ok(apiScope.isDone())
    assert.ok(evilScope.isDone())
    assert.ok(entries.some(e => e.type === 'warning' && /another origin/.test(e.msg)), 'expected a warning about the other origin')
  })

  it('should warn when the results path does not point to an array while paginating', async function () {
    const apiScope = nock('https://api.insee.fr')
      .get('/entreprises/sirene/V3.11/siret').query({ nombre: '2', debut: '0' }).reply(200, { etablissements: sirene.etablissements.slice(0, 2) })

    const context = sireneContext(sireneConfig({
      resultsPath: '',
      pagination: { method: 'queryParams', limitKey: 'nombre', limitValue: 2, offsetKey: 'debut' }
    }))
    const entries = recordLog(context)
    await run(context, true)
    assert.ok(apiScope.isDone())
    assert.ok(entries.some(e => e.type === 'warning' && /results array path/.test(e.msg)), 'expected a warning about the results path')
  })

  it('should stop between two pages and never upload a truncated file', async function () {
    const page = (i: number) => ({ etablissements: sirene.etablissements.slice(i, i + 2) })
    const apiScope = nock('https://api.insee.fr')
      .get('/entreprises/sirene/V3.11/siret').query({ nombre: '2', debut: '0' })
      // the interruption arrives while the first page is being read
      .reply(200, async () => { await stop(); return page(0) })
    const secondPage = nock('https://api.insee.fr')
      .get('/entreprises/sirene/V3.11/siret').query({ nombre: '2', debut: '2' }).reply(200, page(2))
    const dfScope = nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`).reply(200, restDataset())
      .post(`${dfPath}/api/v1/datasets/sirene-ds/_bulk_lines`).query(true).reply(200, { nbOk: 2, nbErrors: 0 })

    const context = sireneContext(sireneConfig({
      pagination: { method: 'queryParams', limitKey: 'nombre', limitValue: 2, offsetKey: 'debut' }
    }))
    const entries = recordLog(context)
    await run(context)

    assert.ok(apiScope.isDone())
    assert.ok(!secondPage.isDone(), 'the second page must not be fetched after a stop')
    assert.ok(!dfScope.isDone(), 'a stopped run must not upload anything')
    assert.ok(entries.some(e => e.type === 'warning' && /stopped/i.test(e.msg)), 'expected a warning about the interruption')
    assert.ok(!fs.existsSync('data/sirene.csv'), 'the temporary CSV must be removed')
  })

  it('should run again normally after a stopped run', async function () {
    const apiScope = nockSireneApi()
    await run(sireneContext(sireneConfig()), true)
    assert.ok(apiScope.isDone())
  })

  it('should create an editable dataset with a string schema, then fill it', async function () {
    nockSireneApi()
    let created: any
    const dfScope = nock(dfOrigin)
      .post(`${dfPath}/api/v1/datasets`, (body) => { created = body; return true })
      // data-fair answers the created dataset with its (extended) schema
      .reply(201, () => ({ id: 'sirene-new', title: 'Sirene', isRest: true, schema: [...created.schema, { key: '_id', type: 'string', 'x-calculated': true }] }))
      .post(`${dfPath}/api/v1/datasets/sirene-new/_bulk_lines`)
      .query({ drop: 'false' })
      .reply(200, { nbOk: 20, nbErrors: 0, nbCreated: 20 })

    const patches: any[] = []
    const context = sireneContext(sireneConfig({
      datasetMode: 'create',
      dataset: undefined,
      datasetTitle: 'Sirene',
      editableCreate: true
    }))
    context.patchConfig = async (patch: any) => { patches.push(patch) }

    await run(context)

    assert.ok(dfScope.isDone())
    assert.equal(created.isRest, true)
    assert.equal(created.title, 'Sirene')
    assert.equal(created.primaryKey, undefined)
    assert.deepStrictEqual(created.schema, [{ key: 'siret', type: 'string' }, { key: 'denominationUniteLegale', type: 'string' }])
    // the next run must update the dataset, and know it is editable
    assert.deepStrictEqual(patches, [{ datasetMode: 'update', dataset: { id: 'sirene-new', title: 'Sirene', isRest: true } }])
  })

  it('should create a file dataset from the flat datasetTitle', async function () {
    nockSireneApi()
    const patches: any[] = []
    const dfScope = nock(dfOrigin)
      .post(`${dfPath}/api/v1/datasets/`)
      .reply(201, { id: 'sirene-file', title: 'Sirene fichier' })
    const context = sireneContext(sireneConfig({ datasetMode: 'create', dataset: undefined, datasetTitle: 'Sirene fichier' }))
    context.patchConfig = async (patch: any) => { patches.push(patch) }
    await run(context)
    assert.ok(dfScope.isDone())
    assert.deepStrictEqual(patches, [{ datasetMode: 'update', dataset: { id: 'sirene-file', title: 'Sirene fichier', isRest: false } }])
  })

  it('should send lines to an editable dataset through _bulk_lines, never as a file', async function () {
    const apiScope = nockSireneApi()
    const dfScope = nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(200, restDataset())
      .post(`${dfPath}/api/v1/datasets/sirene-ds/_bulk_lines`)
      .query({ drop: 'false' })
      .reply(200, { nbOk: 20, nbErrors: 0, nbCreated: 20, nbModified: 0, nbDeleted: 0, nbNotModified: 0 })

    await run(sireneContext(sireneConfig()))

    assert.ok(apiScope.isDone())
    // a pending mock here would mean the file route was taken instead of _bulk_lines
    assert.ok(dfScope.isDone(), 'the editable dataset must be fed through _bulk_lines')
  })

  it('should pass drop=true and refuse to empty an editable dataset when the API returns nothing', async function () {
    nock('https://api.insee.fr')
      .get('/entreprises/sirene/V3.11/siret')
      .reply(200, { etablissements: [] })
    nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(200, restDataset())

    await assert.rejects(
      run(sireneContext(sireneConfig({ drop: true }))),
      /import cancelled so as not to empty the dataset/
    )
  })

  it('should leave an editable dataset untouched when the API returns nothing and drop is off', async function () {
    nock('https://api.insee.fr')
      .get('/entreprises/sirene/V3.11/siret')
      .reply(200, { etablissements: [] })
    const dfScope = nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(200, restDataset())
      .post(`${dfPath}/api/v1/datasets/sirene-ds/_bulk_lines`)
      .query(true)
      .reply(200, { nbOk: 0, nbErrors: 0 })

    await run(sireneContext(sireneConfig()))

    assert.ok(
      dfScope.pendingMocks().some(m => m.includes('_bulk_lines')),
      'un import vide ne doit pas appeler _bulk_lines'
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
      run(sireneContext(sireneConfig())),
      /2 rows in error out of 20/
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
      run(sireneContext(sireneConfig({ drop: true }))),
      /Data Fair cancelled the data replacement.*the previous data is kept/
    )
  })

  it('should reject columns missing from the editable dataset schema before uploading', async function () {
    nockSireneApi()
    nock(dfOrigin)
      .get(`${dfPath}/api/v1/datasets/sirene-ds`)
      .reply(200, restDataset({ schema: [{ key: 'siret', type: 'string' }] }))

    await assert.rejects(
      run(sireneContext(sireneConfig())),
      /Columns missing from the schema.*denominationUniteLegale/
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
      run(sireneContext(sireneConfig())),
      /Failed to upload the file.*this dataset is not file based/
    )
  })

  describe('requests to the configured API', () => {
    it('should follow a same-origin redirect with the credential headers', async () => {
      const scope = nock('https://api.test')
        .get('/old').reply(301, '', { Location: 'https://api.test/new' })
      const target = nock('https://api.test', { reqheaders: { 'x-api-key': 'secret' } })
        .get('/new').reply(200, { ok: true })
      const res = await axios.get('https://api.test/old', { headers: { 'X-API-Key': 'secret' }, ...externalRequestOptions('https://api.test/old', ['X-API-Key']) })
      assert.deepEqual(res.data, { ok: true })
      assert.ok(scope.isDone() && target.isDone())
    })

    it('should drop the credential headers on a cross-origin redirect', async () => {
      nock('https://api.test')
        .get('/old').reply(302, '', { Location: 'https://cdn.test/file' })
      const target = nock('https://cdn.test', { badheaders: ['x-api-key', 'session-token'] })
        .get('/file').reply(200, { ok: true })
      const res = await axios.get('https://api.test/old', {
        headers: { 'X-API-Key': 'secret', 'Session-Token': 'tok' },
        ...externalRequestOptions('https://api.test/old', ['X-API-Key', 'Session-Token'])
      })
      assert.deepEqual(res.data, { ok: true })
      assert.ok(target.isDone())
    })
  })

  describe('data-fair retry', () => {
    const warnings: string[] = []
    const log = { warning: async (msg: string) => { warnings.push(msg) } }

    it('should retry a call answered 429', async () => {
      let calls = 0
      const result = await dfRetry(async () => {
        calls++
        if (calls < 3) throw Object.assign(new Error('429'), { status: 429 })
        return 'ok'
      }, log, 3, 1)
      assert.equal(result, 'ok')
      assert.equal(calls, 3)
      assert.equal(warnings.length, 2)
    })

    it('should not retry other errors', async () => {
      let calls = 0
      await assert.rejects(dfRetry(async () => {
        calls++
        throw Object.assign(new Error('500'), { response: { status: 500 } })
      }, log, 3, 1), /500/)
      assert.equal(calls, 1)
    })
  })
})
