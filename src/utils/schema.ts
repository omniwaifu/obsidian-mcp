import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/**
 * Creates a tool schema handler that manages both JSON Schema for MCP and Zod validation
 */
export function createSchemaHandler<T>(schema: z.ZodSchema<T>) {
  return {
    // Convert to JSON Schema for MCP interface
    jsonSchema: (() => {
      const fullSchema = zodToJsonSchema(schema) as {
        type: string;
        properties: Record<string, any>;
        required?: string[];
      };
      return {
        type: fullSchema.type || "object",
        properties: fullSchema.properties || {},
        required: fullSchema.required || [],
      };
    })(),

    // Validate and parse input
    parse: (input: unknown): T => {
      try {
        return schema.parse(input);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid arguments: ${error.errors.map((e) => e.message).join(", ")}`,
          );
        }
        throw error;
      }
    },
  };
}
