# <img alt="Data FAIR logo" src="https://cdn.jsdelivr.net/gh/data-fair/data-fair@master/ui/public/assets/logo.svg" width="30"> @data-fair/processing-import-api

Processing plugin for the [Data Fair](https://github.com/data-fair/processings) platform that creates (or updates) a dataset by harvesting data from any HTTP/JSON API.

## Features

- **Flexible authentication** — Supports public APIs as well as Basic Auth, Bearer Token, API key, OAuth 2.0 (client / password credentials) and GLPI-style session tokens. Secrets are stored separately from the configuration.
- **Pagination** — Handles no pagination, query-parameter pagination (`offset`/`limit`) and "next page" links extracted from the response body.
- **Field mapping** — A recursive block configuration maps nested JSON properties to flat CSV columns, including the expansion of nested arrays into multiple rows.

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
| `auth` | Authentication method (none, basic, bearer, API key, OAuth 2.0 or session). |
| `pagination` | Pagination strategy: none, query parameters or next-page link. |

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
