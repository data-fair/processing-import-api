# <img alt="Data FAIR logo" src="https://cdn.jsdelivr.net/gh/data-fair/data-fair@master/ui/public/assets/logo.svg" width="30"> @data-fair/processing-import-api

Processing plugin for the [Data Fair](https://github.com/data-fair/processings) platform that creates (or updates) a dataset by harvesting data from any HTTP/JSON API.

## Features

- **Flexible authentication** — Supports public APIs as well as Basic Auth, Bearer Token, API key, OAuth 2.0 (client / password credentials) and login-then-token sessions (Parkki, GLPI…). Secrets are stored separately from the configuration.
- **Pagination** — Handles no pagination, query-parameter pagination (`offset`/`limit`) and "next page" links extracted from the response body.
- **Field mapping** — A recursive block configuration maps nested JSON properties to flat CSV columns, including the expansion of nested arrays into multiple rows.
- **File and editable datasets** — The target dataset type is detected automatically on update: a file dataset gets the CSV as a file upload, an editable (REST) dataset gets it through `_bulk_lines`.

## Updating an editable dataset

The type of the target dataset is read from Data Fair at each run, so there is nothing to
configure: pick the dataset, and the plugin picks the right API. Two things are worth knowing
about editable datasets.

**Columns must already exist in the schema.** `_bulk_lines` never derives the schema from the
data it receives, so every key of the mapping has to match a column of the target dataset. The
plugin checks this before uploading and names the missing columns rather than letting Data Fair
reject the whole import.

**Lines are matched on the dataset's primary key.** Without one, Data Fair gives each incoming
line a random id, so every run appends a full copy of the data instead of updating it. Define a
primary key on the dataset — the plugin warns when it is missing.

| Field | Description |
| ----- | ----------- |
| `drop` | Replace the data instead of adding to it: lines no longer returned by the API are removed. The replacement is atomic — on error the previous data is kept. An import that retrieved no line at all is refused, so a broken API cannot empty the dataset. No effect on a file dataset, where the new file always replaces everything. |

Creating an editable dataset is not supported yet: create it in Data Fair, then point the
processing at it.

## Configuration

### Dataset

| Field | Description |
| ----- | ----------- |
| `datasetMode` | `create` a new dataset or `update` an existing one. |
| `dataset` | Title of the dataset to create, or id/title of the dataset to update. |

### Data source

| Field | Description |
| ----- | ----------- |
| `apiURL` | URL of the API to harvest. |
| `auth` | Authentication method (none, basic, bearer, API key, OAuth 2.0 or session), see below. |
| `pagination` | Pagination strategy: none, query parameters or next-page link. |

#### Session authentication (login, then token)

For APIs with their own login endpoint returning a short-lived token. The plugin logs in once
per run, so the token expiry is never a concern, and sends the token in a header on every data
request. The defaults reproduce the GLPI `initSession` flow.

| Field | Default | Description |
| ----- | ------- | ----------- |
| `loginURL` | | Login endpoint, called once per run. |
| `loginMethod` | `GET` | `GET` or `POST`. |
| `username` / `password` | | Credentials, or an application id / API key. `password` is stored as a secret. |
| `usernameField` / `passwordField` | | When both are set, the credentials are sent as a JSON body `{ <usernameField>: username, <passwordField>: password }`. Otherwise they go in a `Basic` `Authorization` header. |
| `tokenPath` | `session_token` | Dot-notation path of the token in the login response (e.g. `access_token.token`). |
| `tokenHeader` | `Session-Token` | Header carrying the token on the data requests (e.g. `X-Access-Token`). |
| `tokenApp` | | GLPI `App-Token`, sent on every request. |
| `tokenUser` | | GLPI `user_token`, used instead of username / password. |

Example, Parkki: `loginURL = https://client.parkki.io/v2.4/auth/app`, `loginMethod = POST`,
`usernameField = app_id`, `passwordField = api_key`, `tokenPath = access_token.token`,
`tokenHeader = X-Access-Token`.

### Fields to retrieve

| Field | Description |
| ----- | ----------- |
| `resultsPath` | Path to the results array in the JSON response. |
| `block` | Recursive mapping of JSON paths to CSV columns. |
| `separator` | Separator used to join multivalued fields. |

#### Path syntax

Each column maps a JSON `path` to a CSV column. Use dot notation to navigate
through objects and `[]` to extract data from arrays.

| Notation | Example | Behaviour |
| -------- | ------- | --------- |
| **Simple** | `owner.name` | Accesses a nested property. |
| **Array (multivalued)** | `topics[].title` | Collects the `title` of every item of the `topics` array and joins them into a single multivalued field, using the configured `separator`. |
| **Precise index** | `attributes.0` / `attributes.1.title` | Targets a specific item of an array by its position. Use the position number (starting at `0`), **not** `[0]`. |

> The difference between `[]` and a numeric index: `topics[].title` returns
> *all* the titles concatenated into one column, whereas `topics.0.title`
> returns only the title of the first item.

To turn a nested array into **several rows** (instead of one multivalued
column), use the `expand` part of a block: set `expand.path` to the array and
describe the columns of each item in the nested `expand.block`. Blocks are
recursive, so arrays can be expanded at any depth.

## Development

```bash
npm install
npm run build-types   # generate types from the JSON schemas
npm run lint
npm test
```

## Release

Publishing is handled automatically by CI: the plugin is pushed to the data-fair registry (`@data-fair/registry`), not to the public npm registry — there is no manual `npm publish`. A push to `main`/`master` publishes to the staging registry; pushing a `v*` tag publishes to production:

```bash
npm version minor       # version bump + v* tag
git push --follow-tags  # CI publishes to the production registry
```
