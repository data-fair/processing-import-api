import type { PrepareFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

/** Keys of the auth object that hold a secret, whatever the authentication method. */
export const secretKeys = ['password', 'apiKeyValue', 'clientSecret']

/**
 * When the configuration is saved, move the secrets of the auth object to the secrets store
 * and replace them with '********' in the config. An emptied field removes the secret.
 */
const prepare: PrepareFunction<ProcessingConfig> = async ({ processingConfig, secrets }) => {
  const auth = processingConfig.auth as Record<string, any> | undefined
  if (!auth) return { processingConfig, secrets }

  for (const key of secretKeys) {
    if (auth[key] && auth[key] !== '********') {
      secrets[key] = auth[key]
      auth[key] = '********'
    }
    if (!auth[key] && secrets[key]) {
      delete secrets[key]
    }
  }

  return { processingConfig, secrets }
}

export default prepare
