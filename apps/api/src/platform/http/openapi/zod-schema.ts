/** OpenAPI projection of the pinned Zod contracts; runtime refinements remain server enforced. */
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface.js';
import type { z } from 'zod';

type ZodSchema = z.core.$ZodType;
type ZodDef = z.core.$ZodTypes['_zod']['def'];
type ZodCheckDef = (z.core.$ZodChecks | z.core.$ZodStringFormatChecks)['_zod']['def'];

export function zodOpenApiSchema(schema: ZodSchema): SchemaObject {
  const def = schema._zod.def as ZodDef;
  // Transforms project their input; preprocessors project the schema they feed into.
  if (def.type === 'pipe')
    return zodOpenApiSchema(def.in._zod.def.type === 'transform' ? def.out : def.in);
  if (def.type === 'optional') return zodOpenApiSchema(def.innerType);
  if (def.type === 'nullable') return { ...zodOpenApiSchema(def.innerType), nullable: true };
  if (def.type === 'default')
    return { ...zodOpenApiSchema(def.innerType), default: def.defaultValue };
  const scalar = scalarSchema(def);
  if (scalar) return scalar;
  if (def.type === 'object') return objectSchema(def);
  if (def.type === 'array')
    return {
      type: 'array',
      items: zodOpenApiSchema(def.element),
      ...lengthBounds(def.checks),
    };
  if (def.type === 'record')
    return { type: 'object', additionalProperties: zodOpenApiSchema(def.valueType) };
  if (def.type === 'union')
    return 'discriminator' in def
      ? { oneOf: def.options.map(zodOpenApiSchema) }
      : { anyOf: def.options.map(zodOpenApiSchema) };
  if (def.type === 'unknown' || def.type === 'any') return {};
  throw new Error(`Unsupported OpenAPI contract: ${def.type}`);
}

function checkDefs(checks: z.core.$ZodTypeDef['checks']): ZodCheckDef[] {
  return (checks ?? []).map((check) => check._zod.def as ZodCheckDef);
}

function lengthBounds(checks: z.core.$ZodTypeDef['checks']): SchemaObject {
  const result: SchemaObject = {};
  for (const check of checkDefs(checks)) {
    if (check.check === 'min_length') result.minItems = check.minimum;
    if (check.check === 'max_length') result.maxItems = check.maximum;
  }
  return result;
}

function objectSchema(def: z.core.$ZodObjectDef): SchemaObject {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(def.shape)) {
    properties[key] = zodOpenApiSchema(value);
    if (!(value as z.ZodType).isOptional()) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: def.catchall?._zod.def.type === 'unknown',
  };
}

function stringSchema(def: z.core.$ZodStringDef): SchemaObject {
  const result: SchemaObject = { type: 'string' };
  for (const check of checkDefs(def.checks)) {
    if (check.check === 'min_length') result.minLength = check.minimum;
    if (check.check === 'max_length') result.maxLength = check.maximum;
    if (check.check !== 'string_format') continue;
    if (check.format === 'regex' && check.pattern) result.pattern = check.pattern.source;
    if (check.format === 'datetime') result.format = 'date-time';
    if (check.format === 'date') result.format = 'date';
    if (check.format === 'email') result.format = 'email';
    if (check.format === 'cuid') result.format = 'cuid';
  }
  return result;
}

function numberSchema(def: z.core.$ZodNumberDef): SchemaObject {
  const result: SchemaObject = { type: 'number' };
  for (const check of checkDefs(def.checks)) {
    if (check.check === 'number_format' && check.format === 'safeint') result.type = 'integer';
    if (check.check === 'multiple_of') result.multipleOf = Number(check.value);
    if (check.check === 'greater_than') {
      result.minimum = Number(check.value);
      result.exclusiveMinimum = !check.inclusive;
    }
    if (check.check === 'less_than') {
      result.maximum = Number(check.value);
      result.exclusiveMaximum = !check.inclusive;
    }
  }
  return result;
}

function scalarSchema(def: ZodDef): SchemaObject | undefined {
  if (def.type === 'null') return { nullable: true };
  if (def.type === 'string') return stringSchema(def);
  if (def.type === 'number') return numberSchema(def);
  if (def.type === 'boolean') return { type: 'boolean' };
  if (def.type === 'enum') return { type: 'string', enum: Object.values(def.entries) };
  if (def.type === 'literal') {
    const [value] = def.values;
    return { type: typeof value, enum: [value] };
  }
  return undefined;
}
