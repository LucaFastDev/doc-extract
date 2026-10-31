import type { CheckContext } from './checks.ts'
import type { DuplicateKey } from './duplicate.ts'
import type { CheckResult, DocumentValues, FieldDef, ToolDefinition } from './fields.ts'

// What one document type defines, once, for extraction, checks and (later) review and export
// (PRD US-3.1 AC-1). Each type's module exports one; index.ts lists them.

export interface DocTypeDef {
  tool: ToolDefinition
  fields: FieldDef[]
  /** The tool input's list of lines: line_items, or transactions for a bank statement. Stored as line_items[i]. */
  linesKey: string
  lineFields: FieldDef[]
  /** Every check of the type, U1 as it stands with no earlier document (duplicate.ts). */
  checks: (values: DocumentValues, context: CheckContext) => CheckResult[]
  duplicateKey: (values: DocumentValues) => DuplicateKey
  /** Whether the currency rule applies: false for a delivery note, which has no amounts (OQ-16). */
  flagsCurrency: boolean
}
