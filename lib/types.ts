// Supporting types shared accross the processing implementation.

export interface MappingField {
  key: string
  path: string
}

export interface Block {
  mapping?: MappingField[]
  expand?: {
    path?: string
    block?: Block
  }
}

export interface Auth {
  authMethod: 'noAuth' | 'basicAuth' | 'bearerAuth' | 'apiKey' | 'oauth2' | 'session'
  username?: string
  password?: string
  token?: string
  apiKeyHeader?: string
  apiKeyValue?: string
  grantType?: string
  clientId?: string
  clientSecret?: string
  scope?: string
  tokenURL?: string
  loginURL?: string
  tokenApp?: string
  tokenUser?: string
  [k: string]: any
}

export interface PaginationConfig {
  method: 'none' | 'queryParams' | 'nextPageData'
  offsetKey?: string
  offsetPages?: boolean
  limitKey?: string
  limitValue?: number
  nextPagePath?: string
}
