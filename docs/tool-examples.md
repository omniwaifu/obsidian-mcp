# Tool Implementation Examples

This document provides practical examples of common tool implementation patterns and anti-patterns.

## Example 1: File Operation Tool

### ✅ Good Implementation

```typescript
import { z } from "zod";
import { Tool, FileOperationResult } from "../../types.js";
import { validateVaultPath } from "../../utils/path.js";
import { handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createSchemaHandler } from "../../utils/schema.js";

const schema = z
  .object({
    path: z
      .string()
      .min(1, "Path cannot be empty")
      .refine((path) => !path.includes(".."), "Path cannot contain '..'")
      .describe("Path to the file relative to vault root"),
    content: z
      .string()
      .min(1, "Content cannot be empty")
      .describe("File content to write"),
  })
  .strict();

const schemaHandler = createSchemaHandler(schema);

async function writeFile(
  vaultPath: string,
  filePath: string,
  content: string,
): Promise<FileOperationResult> {
  const fullPath = path.join(vaultPath, filePath);
  validateVaultPath(vaultPath, fullPath);

  try {
    await ensureDirectory(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, "utf8");

    return {
      success: true,
      message: "File written successfully",
      path: fullPath,
      operation: "create",
    };
  } catch (error) {
    throw handleFsError(error, "write file");
  }
}

export function createWriteFileTool(vaultPath: string): Tool {
  if (!vaultPath) {
    throw new Error("Vault path is required");
  }

  return {
    name: "write-file",
    description: "Write content to a file in the vault",
    inputSchema: schemaHandler,
    handler: async (args) => {
      const validated = schemaHandler.parse(args);
      const result = await writeFile(
        vaultPath,
        validated.path,
        validated.content,
      );
      return createToolResponse(formatFileResult(result));
    },
  };
}
```

### ❌ Bad Implementation

```typescript
// Anti-pattern example
export function createBadWriteFileTool(vaultPath: string): Tool {
  return {
    name: "write-file",
    description: "Writes a file", // Too vague
    inputSchema: {
      // Missing proper schema handler
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
      },
      parse: (input: any) => input, // No validation!
    },
    handler: async (args) => {
      try {
        // Missing path validation
        const filePath = path.join(vaultPath, args.path);

        // Direct fs operations without proper error handling
        await fs.writeFile(filePath, args.content);

        // Poor response formatting
        return createToolResponse("File written");
      } catch (error) {
        // Bad error handling
        return createToolResponse(`Error: ${error}`);
      }
    },
  };
}
```

## Example 2: Search Tool

### ✅ Good Implementation

```typescript
const schema = z
  .object({
    query: z
      .string()
      .min(1, "Search query cannot be empty")
      .describe("Text to search for"),
    caseSensitive: z
      .boolean()
      .optional()
      .describe("Whether to perform case-sensitive search"),
    path: z
      .string()
      .optional()
      .describe("Optional subfolder to limit search scope"),
  })
  .strict();

const schemaHandler = createSchemaHandler(schema);

async function searchFiles(
  vaultPath: string,
  query: string,
  options: SearchOptions,
): Promise<SearchOperationResult> {
  try {
    const searchPath = options.path
      ? path.join(vaultPath, options.path)
      : vaultPath;

    validateVaultPath(vaultPath, searchPath);

    // Implementation details...

    return {
      success: true,
      message: "Search completed",
      results: matches,
      totalMatches: totalCount,
      matchedFiles: fileCount,
    };
  } catch (error) {
    throw handleFsError(error, "search files");
  }
}

export function createSearchTool(vaultPath: string): Tool {
  if (!vaultPath) {
    throw new Error("Vault path is required");
  }

  return {
    name: "search-files",
    description: "Search for text in vault files",
    inputSchema: schemaHandler,
    handler: async (args) => {
      const validated = schemaHandler.parse(args);
      const result = await searchFiles(vaultPath, validated.query, {
        caseSensitive: validated.caseSensitive,
        path: validated.path,
      });
      return createToolResponse(formatSearchResult(result));
    },
  };
}
```

### ❌ Bad Implementation

```typescript
// Anti-pattern example
export function createBadSearchTool(vaultPath: string): Tool {
  return {
    name: "search",
    description: "Searches files",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      parse: (input: any) => input,
    },
    handler: async (args) => {
      // Bad: Recursive search without limits
      async function searchDir(dir: string): Promise<string[]> {
        const results: string[] = [];
        const files = await fs.readdir(dir);

        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = await fs.stat(fullPath);

          if (stat.isDirectory()) {
            results.push(...(await searchDir(fullPath)));
          } else {
            const content = await fs.readFile(fullPath, "utf8");
            if (content.includes(args.query)) {
              results.push(fullPath);
            }
          }
        }

        return results;
      }

      try {
        const matches = await searchDir(vaultPath);
        // Poor response formatting
        return createToolResponse(`Found matches in:\n${matches.join("\n")}`);
      } catch (error) {
        return createToolResponse(`Search failed: ${error}`);
      }
    },
  };
}
```

## Common Anti-Patterns to Avoid

1. **Poor Error Handling**

```typescript
// ❌ Bad
catch (error) {
  return createToolResponse(`Error: ${error}`);
}

// ✅ Good
catch (error) {
  if (error instanceof McpError) {
    throw error;
  }
  throw handleFsError(error, 'operation name');
}
```

2. **Missing Input Validation**

```typescript
// ❌ Bad
const input = args as { path: string };

// ✅ Good
const validated = schemaHandler.parse(args);
```

3. **Unsafe Path Operations**

```typescript
// ❌ Bad
const fullPath = path.join(vaultPath, args.path);

// ✅ Good
const fullPath = path.join(vaultPath, validated.path);
validateVaultPath(vaultPath, fullPath);
```

4. **Poor Response Formatting**

```typescript
// ❌ Bad
return createToolResponse(JSON.stringify(result));

// ✅ Good
return createToolResponse(formatOperationResult(result));
```

5. **Direct File System Operations**

```typescript
// ❌ Bad
await fs.writeFile(path, content);

// ✅ Good
await ensureDirectory(path.dirname(fullPath));
await fs.writeFile(fullPath, content, "utf8");
```

Remember:

- Always use utility functions for common operations
- Validate all inputs thoroughly
- Handle errors appropriately
- Format responses consistently
- Follow the established patterns in the codebase
