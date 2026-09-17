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
      const res = await axios.post(auth.tokenURL as string, formData)
      headers.Authorization = `Bearer ${res.data.access_token}`
    } catch (e) {
      await log.error('Erreur lors de l\'obtention du token')
      await log.error(JSON.stringify(e))
      throw new Error('Erreur lors de l\'obtention du token')
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
      throw new Error('Aucune méthode d\'authentification n\'a été renseignée')
    }

    if (auth.tokenApp) {
      headers['App-Token'] = auth.tokenApp
      headersSession['App-Token'] = auth.tokenApp
    }

    await log.debug(`Fetch session token (${loginMethod.toUpperCase()} ${auth.loginURL}) with headers: ${JSON.stringify(Object.keys(headersSession))}`)
    const sessionRes = await axios({ method: loginMethod, url: auth.loginURL as string, headers: headersSession, data: body })
    const token = sessionRes.data && getValueByPath(sessionRes.data, tokenPath)
    if (typeof token === 'string' && token) {
      headers[tokenHeader] = token
    } else {
      throw new Error(`Erreur lors de la récupération du token de session : aucun jeton trouvé au chemin "${tokenPath}" dans la réponse de ${auth.loginURL}`)
    }
  }

  await log.debug(`Return authentication headers: ${JSON.stringify(Object.keys(headers))}`)

  return headers
}
