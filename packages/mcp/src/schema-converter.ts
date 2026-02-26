import type { ToolParameterDefinition, ParameterType } from "@simulacra-ai/core";

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  items?: JsonSchemaProperty;
  default?: unknown;
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

function convertProperty(
  name: string,
  prop: JsonSchemaProperty,
  required: boolean,
): ToolParameterDefinition {
  const param_type = convertType(prop, required);
  const def: ToolParameterDefinition = { ...param_type, name };
  if (prop.description) {
    def.description = prop.description;
  }
  return def;
}

function convertType(prop: JsonSchemaProperty, required: boolean): ParameterType {
  if (prop.type === "object" && prop.properties) {
    const nested: Record<string, ParameterType> = {};
    for (const [key, value] of Object.entries(prop.properties)) {
      const child_required = prop.required?.includes(key) ?? false;
      nested[key] = convertType(value, child_required);
    }
    return {
      type: "object",
      required,
      properties: nested,
      ...(prop.description ? { description: prop.description } : {}),
    };
  }

  if (prop.type === "array" && prop.items) {
    return {
      type: "array",
      required,
      items: convertType(prop.items, false),
      ...(prop.description ? { description: prop.description } : {}),
    };
  }

  if (prop.type === "string" && prop.enum) {
    return required
      ? {
          type: "string",
          required: true,
          enum: prop.enum,
          ...(prop.description ? { description: prop.description } : {}),
        }
      : {
          type: "string",
          required: false,
          enum: prop.enum,
          ...(prop.description ? { description: prop.description } : {}),
        };
  }

  if (prop.type === "number" || prop.type === "integer") {
    return required
      ? {
          type: "number",
          required: true,
          ...(prop.description ? { description: prop.description } : {}),
        }
      : {
          type: "number",
          required: false,
          ...(prop.description ? { description: prop.description } : {}),
        };
  }

  if (prop.type === "boolean") {
    return required
      ? {
          type: "boolean",
          required: true,
          ...(prop.description ? { description: prop.description } : {}),
        }
      : {
          type: "boolean",
          required: false,
          ...(prop.description ? { description: prop.description } : {}),
        };
  }

  // Default: treat as string (covers type === "string" and unknown types)
  return required
    ? {
        type: "string",
        required: true,
        ...(prop.description ? { description: prop.description } : {}),
      }
    : {
        type: "string",
        required: false,
        ...(prop.description ? { description: prop.description } : {}),
      };
}

/**
 * Converts a JSON Schema object into an array of Simulacra tool parameter definitions.
 *
 * This function transforms MCP tool input schemas (which use JSON Schema format)
 * into the parameter format expected by Simulacra tools. It handles nested objects,
 * arrays, enums, and all standard JSON Schema primitive types.
 *
 * @param schema - A JSON Schema object describing the tool's input parameters.
 * @returns An array of tool parameter definitions compatible with Simulacra.
 */
export function convertJsonSchemaToParameters(
  schema: Record<string, unknown>,
): ToolParameterDefinition[] {
  const s = schema as unknown as JsonSchema;
  if (!s.properties) {
    return [];
  }

  const required_set = new Set(s.required ?? []);
  return Object.entries(s.properties).map(([name, prop]) =>
    convertProperty(name, prop, required_set.has(name)),
  );
}
