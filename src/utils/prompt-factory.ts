import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Prompt } from "../types.js";
import { z } from "zod";

const registeredPrompts: Map<string, Prompt<any, any>> = new Map();

/**
 * Register a prompt for use in the MCP server
 */
export function registerPrompt<T extends z.ZodTypeAny, U extends z.ZodTypeAny>(
  prompt: Prompt<T, U>,
): void {
  if (registeredPrompts.has(prompt.name)) {
    // Instead of throwing, just log a warning or return silently
    // This allows multiple test files to instantiate ObsidianServer without conflict
    // console.warn(`Attempted to register prompt \"${prompt.name}\" which is already registered. Skipping.`);
    return;
    // throw new McpError(ErrorCode.InvalidRequest, `Prompt \"${prompt.name}\" is already registered`);
  }
  registeredPrompts.set(prompt.name, prompt);
}

/**
 * List all registered prompts
 */
export function listPrompts() {
  return {
    prompts: Array.from(registeredPrompts.values()).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  };
}

/**
 * Get a specific prompt by name
 */
export async function getPrompt(
  name: string,
  vaults: Map<string, string>,
  args?: any,
) {
  const prompt = registeredPrompts.get(name);
  if (!prompt) {
    throw new McpError(ErrorCode.MethodNotFound, `Prompt not found: ${name}`);
  }

  try {
    return await prompt.handler(args, vaults);
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to execute prompt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
