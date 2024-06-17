module.exports = async (auth, axios, log) => {
  const headers = {}

  if (auth.authMethod === 'bearerAuth') headers.Authorization = `Bearer ${auth.token}`
  else if (auth.authMethod === 'basicAuth') headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
  else if (auth.authMethod === 'apiKey') headers[auth.apiKeyHeader] = auth.apiKeyValue
  else if (auth.authMethod === 'oauth2') {
    const formData = new URLSearchParams()

    formData.append('grant_type', auth.grantType)
    formData.append('client_id', auth.clientId)
    formData.append('client_secret', auth.clientSecret)

    if (auth.grantType === 'password_Credentials') {
      formData.append('username', auth.username)
      formData.append('password', auth.password)
    }

    try {
      const res = await axios.post(auth.tokenURL, formData)
      headers.Authorization = `Bearer ${res.data.access_token}`
    } catch (e) {
      await log.error('Erreur lors de l\'obtention du token')
      await log.error(JSON.stringify(e))
      throw new Error('Erreur lors de l\'obtention du token')
    }
  } else if (auth.authMethod === 'session') {
    const headersSession = { 'Content-Type': 'application/json' }
    if (auth.username && auth.password) {
      headersSession.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
    } else if (auth.tokenUser) {
      headersSession.Authorization = `user_token ${auth.tokenUser}`
    } else {
      throw new Error('Aucune méthode d\'authentification n\'a été renseignée')
    }

    if (auth.tokenApp) {
      headers['App-Token'] = auth.tokenApp
      headersSession['App-Token'] = auth.tokenApp
    }

    await log.debug(`Fetch GLPI session token with headers: ${JSON.stringify(Object.keys(headersSession))}`)
    const sessionRes = await axios.get(auth.loginURL, { headers: headersSession })
    if (sessionRes.data && sessionRes.data.session_token) {
      headers['Session-Token'] = sessionRes.data.session_token
    } else {
      throw new Error('Erreur lors de la récupération du token de session')
    }
  }

  await log.debug(`Return authentication headers: ${JSON.stringify(Object.keys(headers))}`)

  return headers
}
