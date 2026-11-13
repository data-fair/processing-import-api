import type { AxiosInstance } from 'axios'
import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import { getValueByPath } from './utils.ts'

type Auth = ProcessingConfig['auth']

export default async (auth: Auth, axios: AxiosInstance, log: LogFunctions): Promise<Record<string, string>> => {
  const headers: Record<string, string> = {}

  if (auth.authMethod === 'bearerAuth') headers.Authorization = `Bearer ${auth.token}`
  else if (auth.authMethod === 'basicAuth') headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
  else if (auth.authMethod === 'apiKey') headers[auth.apiKeyHeader as string] = auth.apiKeyValue as string
  else if (auth.authMethod === 'oauth2') {
    const formData = new URLSearchParams()

    formData.append('grant_type', auth.grantType as string)
    formData.append('client_id', auth.clientId as string)
    formData.append('client_secret', auth.clientSecret as string)
    if (auth.scope?.length) formData.append('scope', auth.scope)

    if (auth.grantType === 'password_credentials') {
      formData.append('username', auth.username as string)
      formData.append('password', auth.password as string)
    }

    try {
      // the body carries the client secret: never follow a redirect that would resend it elsewhere
      const res = await axios.post(auth.tokenURL as string, formData, { maxRedirects: 0, timeout: 60000 })
      headers.Authorization = `Bearer ${res.data.access_token}`
    } catch (e: any) {
      // only the response body: the serialized error would carry the request, client secret included
      const status = e?.response?.status ?? e?.status
      await log.error(`Failed to get the OAuth2 token from ${auth.tokenURL}`, e?.response?.data ?? e?.data)
      throw new Error(`Failed to get the OAuth2 token from ${auth.tokenURL}${status ? ` (HTTP ${status})` : `: ${e?.message ?? e}`}`)
    }
  } else if (auth.authMethod === 'session') {
    // Log in once, then send the returned token in a header on every data request.
    // The defaults reproduce the historical GLPI behaviour, so configs saved before the
    // generalization keep working without the new fields.
    const loginMethod = auth.loginMethod === 'POST' ? 'post' : 'get'
    const tokenPath = auth.tokenPath || 'session_token'
    const tokenHeader = auth.tokenHeader || 'Session-Token'
    const headersSession: Record<string, string> = { 'Content-Type': 'application/json' }
    let body: Record<string, string> | undefined

    if (auth.username && auth.password) {
      if (auth.usernameField && auth.passwordField) {
        body = { [auth.usernameField]: auth.username, [auth.passwordField]: auth.password }
      } else {
        headersSession.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
      }
    } else if (auth.tokenUser) {
      headersSession.Authorization = `user_token ${auth.tokenUser}`
    } else {
      throw new Error('Session authentication: fill in either the identifier and the secret, or the user_token')
    }

    if (auth.tokenApp) {
      headers['App-Token'] = auth.tokenApp
      headersSession['App-Token'] = auth.tokenApp
    }

    await log.debug(`Fetch session token (${loginMethod.toUpperCase()} ${auth.loginURL}) with headers: ${JSON.stringify(Object.keys(headersSession))}`)
    // credentials in the headers or the body: never follow a redirect that would resend them elsewhere
    const sessionRes = await axios({ method: loginMethod, url: auth.loginURL as string, headers: headersSession, data: body, maxRedirects: 0, timeout: 60000 })
    const token = sessionRes.data && getValueByPath(sessionRes.data, tokenPath)
    if (typeof token === 'string' && token) {
      headers[tokenHeader] = token
    } else {
      throw new Error(`Failed to get the session token: no token found at the path "${tokenPath}" in the response of ${auth.loginURL}`)
    }
  }

  await log.debug(`Return authentication headers: ${JSON.stringify(Object.keys(headers))}`)

  return headers
}
