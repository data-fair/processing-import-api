import type { PrepareFunction, RunFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

/**
 * Function to prepare a processing (trigger when the config is updated).
 * Moves the secrets of the auth object out of the config.
 */
export const prepare: PrepareFunction<ProcessingConfig> = async (context) => {
  const prepare = (await import('./lib/prepare.ts')).default
  return prepare(context)
}

/**
 * Function to execute the processing (triggered when the processing is started).
 * Fetches the API, flattens the JSON into a CSV and sends it to the dataset.
 */
export const run: RunFunction<ProcessingConfig> = async (context) => {
  const { run } = await import('./lib/execute.ts')
  return run(context)
}

/**
 * Function to stop the processing (triggered when the processing is stopped).
 * The page loop ends after the current page and nothing is uploaded.
 */
export const stop = async () => {
  const { stop } = await import('./lib/execute.ts')
  return stop()
}
