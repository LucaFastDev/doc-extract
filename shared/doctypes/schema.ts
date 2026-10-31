// Validates a tool's input against its JSON Schema again before it is stored (ARCHITECTURE.md
// section 6.3 step 6). It covers the subset the doctype schemas use: object (properties, required,
// additionalProperties false), array (items), string and number.

interface Schema {
  type?: string
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  items?: Schema
}

function join(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`
  return path ? `${path}.${key}` : key
}

/** Every way value breaks schema, each naming where; empty when it matches. */
export function schemaErrors(schema: Schema, value: unknown, path = ''): string[] {
  const where = path || '(input)'
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${where} must be an object`]
      const record = value as Record<string, unknown>
      const errors: string[] = []
      for (const key of schema.required ?? []) {
        if (!(key in record)) errors.push(`${join(path, key)} is missing`)
      }
      for (const [key, child] of Object.entries(record)) {
        const childSchema = schema.properties?.[key]
        if (!childSchema) {
          if (schema.additionalProperties === false) errors.push(`${join(path, key)} is not allowed`)
          continue
        }
        errors.push(...schemaErrors(childSchema, child, join(path, key)))
      }
      return errors
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${where} must be a list`]
      return value.flatMap((item, i) => (schema.items ? schemaErrors(schema.items, item, join(path, i)) : []))
    }
    case 'string':
      return typeof value === 'string' ? [] : [`${where} must be a string`]
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [] : [`${where} must be a number`]
    default:
      return []
  }
}
