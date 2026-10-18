import type { JsonSchemaType, jsonSchemaValidator } from '@modelcontextprotocol/client'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'

// Shared schema safety for the Host input gate and SDK output validation.
export const synchronousJsonSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType) {
    // The SDK wrapper treats a Promise as valid. Keep the root synchronous;
    // AJV also rejects async subschemas/references when compiling a sync root.
    if ('$async' in schema && schema.$async) throw new Error('不支持异步工具 JSON Schema 校验（$async）。')
    // Remote tools may reuse $id for different schemas. Never share AJV's cache.
    return new AjvJsonSchemaValidator().getValidator<T>(schema)
  }
}
