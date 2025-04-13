import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { validateVaultPath } from "../../utils/path.js";
import { handleFsError } from "../../utils/errors.js";
import { createToolResponse } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault to list the directory contents from"),
  path: z.string()
    .optional()
    .default("/") // Default to root if not provided
    .refine(name => !path.isAbsolute(name),
      "Path must be relative to vault root")
    .describe("Path relative to vault root (e.g., 'folder/subfolder' or '/'). Defaults to '/' (vault root)."),
}).strict();

type ListDirectoryInput = z.infer<typeof schema>;

// Define the structure for the output
interface DirectoryListing {
    items: string[]; // Format: "[type] name" e.g., "[file] note.md", "[dir] folder/"
}


async function listDirectoryContents(
  args: ListDirectoryInput,
  vaultPath: string
): Promise<DirectoryListing> {
  const targetPath = path.join(vaultPath, args.path ?? "/");

  // Validate path is within vault
  validateVaultPath(vaultPath, targetPath);

  try {
    const stats = await fs.stat(targetPath);
    if (!stats.isDirectory()) {
      throw new McpError(ErrorCode.InvalidParams, `Path is not a directory: ${args.path}`);
    }

    const dirents = await fs.readdir(targetPath, { withFileTypes: true });
    const items = dirents.map(dirent => {
      const type = dirent.isDirectory() ? "[dir]" : "[file]";
      // Append '/' to directory names for clarity
      const name = dirent.isDirectory() ? `${dirent.name}/` : dirent.name;
      return `${type} ${name}`;
    });

    return { items };
  } catch (error: any) {
     if (error instanceof McpError) {
       throw error;
     }
     if (error.code === 'ENOENT') {
        throw new McpError(ErrorCode.InvalidParams, `Directory not found: ${args.path}`);
     }
    throw handleFsError(error, 'list directory contents');
  }
}

export function createListDirectoryTool(vaults: Map<string, string>) {
  return createTool<ListDirectoryInput>({
    name: "list-directory",
    description: `List files and directories within a specified path in a vault. Defaults to the vault root if no path is provided.

Examples:
- List root: { "vault": "my_vault" }
- List subfolder: { "vault": "my_vault", "path": "documents/projects" }`,
    schema,
    handler: async (args, vaultPath, vaultName) => {
      // --- DEBUG LOG ---
      // console.error(`[DEBUG] list-directory Handler - Received vaultName: ${vaultName}, vaultPath: ${vaultPath}`);
      // --- END DEBUG LOG ---
      try {
          const result = await listDirectoryContents(args, vaultPath);
          const message = result.items.length > 0 
            ? `Contents of '${args.path}':\n${result.items.join('\n')}`
            : `Directory '${args.path}' is empty.`;
          return createToolResponse(message);
      } catch (error: any) {
          if (error instanceof McpError) {
            throw error;
          }
          console.error(`Error listing directory '${args.path}' in vault '${args.vault}':`, error);
          throw handleFsError(error, 'list directory');
      }
    }
  }, vaults);
} 