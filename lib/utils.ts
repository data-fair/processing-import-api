// Get the value of an object by a "path" string
// obj: a javascript object like { a: { b: { c: 1 } } }
// path: a string like "a.b.c"
export const getValueByPath = function (obj: any, path?: string): any {
  if (!path) return obj
  const keys = path.split('.')
  const processed: string[] = []
  for (const key of keys) {
    processed.push(key)
    if (key.includes('[]')) {
      const k = key.split('[]')[0]
      if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
        return obj[k].map((o: any) => getValueByPath(o, path.replace(processed.join('.') + '.', ''))).filter((o: any) => o != null)
      }
    } else if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) {
      obj = obj[key]
    } else {
      return null
    }
  }
  if (obj.constructor === Object) return Object.values(obj)
  else return obj
}

/**
 * Per-request options for the configured API, whose origin we don't control. The processing
 * axios refuses redirects by default (`maxRedirects: 0`), which breaks on an http→https or CDN
 * redirect. Redirects are followed, but follow-redirects only strips `Authorization` and `Cookie`
 * on a cross-host hop: the credential headers of the configured authentication (an API key
 * header, a session token…) are removed here as soon as a hop leaves the origin of the request.
 */
export const externalRequestOptions = (url: string, credentialHeaders: string[] = []) => {
  const sensitive = new Set(credentialHeaders.map(h => h.toLowerCase()))
  let origin: string | undefined
  try { origin = new URL(url).origin } catch { origin = undefined }
  return {
    maxRedirects: 5,
    beforeRedirect: (options: { href?: string, headers?: Record<string, any> }) => {
      if (!sensitive.size || !options.headers) return
      let sameOrigin = false
      try { sameOrigin = !!origin && !!options.href && new URL(options.href).origin === origin } catch { sameOrigin = false }
      if (sameOrigin) return
      for (const name of Object.keys(options.headers)) {
        if (sensitive.has(name.toLowerCase())) delete options.headers[name]
      }
    }
  }
}

/**
 * Run a Data Fair POST with a retry on HTTP 429. The processing axios retries idempotent methods
 * only, never POST. Only 429 is retried: the request was refused before being processed, whereas
 * a 5xx on a dataset creation or a bulk upload may have been partially applied. `fn` is a thunk so
 * that the request, and its streamed body, is rebuilt on each attempt.
 */
export const dfRetry = async <T>(fn: () => Promise<T>, log: { warning: (msg: string) => any }, retries = 3, delayMs = 10000): Promise<T> => {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status
      if (status !== 429 || attempt >= retries) throw err
      attempt++
      await log.warning(`Data Fair answered 429 (too many requests), retrying in ${delayMs / 1000} s (attempt ${attempt}/${retries})`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

/** Default wait for each API request, kept from the former hard-coded value. */
export const DEFAULT_REQUEST_TIMEOUT_MINUTES = 10

/** Longest delay a Node timer accepts: above it, the timer fires after 1 ms instead. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Timeout of each request to the configured API, in milliseconds, from the `requestTimeout`
 * option (minutes). A missing or invalid value falls back to the default. The result is kept
 * between 1 ms (axios reads 0 as "no timeout") and the longest delay a Node timer accepts.
 */
export const requestTimeoutMs = (minutes?: number): number => {
  const value = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_REQUEST_TIMEOUT_MINUTES
  return Math.min(MAX_TIMER_MS, Math.max(1, Math.round(value * 60000)))
}

/**
 * True for the error axios throws when a request exceeds its `timeout` ("timeout of Xms
 * exceeded", code ECONNABORTED, or ETIMEDOUT with `clarifyTimeoutError`). A network-level
 * ETIMEDOUT ("connect ETIMEDOUT 1.2.3.4:443") is not one: raising the option would not help.
 */
export const isRequestTimeout = (err: any): boolean =>
  (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNABORTED') && /^timeout\b/i.test(err?.message ?? '')
