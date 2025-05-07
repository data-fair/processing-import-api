import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from './processing-config/index.mjs'

export type JSONMappingProcessingContext = Omit<ProcessingContext, 'processingConfig'> & { processingConfig: ProcessingConfig }

export interface SchemaField {
  key: string;
  type: string;
  format?: string;
  title?: string;
  'x-originalName'?: string;
  separator?: string;
}
