import { z } from "zod";
import { FileOperationResult } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  ensureMarkdownExtension,
  validateVaultPath,
} from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema with descriptions
const schema = z
  .object({
    vault: z
      .string()
      .min(1, "Vault name cannot be empty")
      .describe("Name of the vault containing the note"),
    path: z
      .string()
      .min(1, "Path cannot be empty")
      .refine(
        (name) => !path.isAbsolute(name),
        "Path must be relative to vault root",
      )
      .describe(
        "Path of the note relative to vault root (e.g., 'folder/note.md'). The .md extension is added automatically if not present.",
      ),
  })
  .strict();

type ReadNoteInput = z.infer<typeof schema>;

// Extended result type for read operations
interface ReadNoteResult extends FileOperationResult {
  content: string;
}

async function readNote(
  vaultPath: string,
  notePath: string,
): Promise<ReadNoteResult> {
  // Apply MD extension check here to the full relative path
  const sanitizedPath = ensureMarkdownExtension(notePath);
  const fullPath = path.join(vaultPath, sanitizedPath);

  // Validate path is within vault
  validateVaultPath(vaultPath, fullPath);

  // Check if file exists first (fail fast)
  if (!(await fileExists(fullPath))) {
    throw createNoteNotFoundError(notePath);
  }

  try {
    // Read the file content
    const content = await fs.readFile(fullPath, "utf-8");

    return {
      success: true,
      message: "Note read successfully",
      path: fullPath,
      operation: "read",
      content: content,
    };
  } catch (error: unknown) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, "read note");
  }
}

export function createReadNoteTool(vaults: Map<string, string>) {
  return createTool<ReadNoteInput>(
    {
      name: "read-note",
      description: `Read the content of an existing note in the vault.
The tool automatically adds the .md extension if not provided.

Examples:
- Root note: { "vault": "vault1", "path": "note.md" }
- Without extension: { "vault": "vault1", "path": "note" }
- Subfolder note: { "vault": "vault1", "path": "journal/2024/note.md" }`,
      schema,
      handler: async (args, vaultPath, _vaultName) => {
        const result = await readNote(vaultPath, args.path);

        // Return content first, followed by metadata
        const metadata = formatFileResult({
          success: result.success,
          message: result.message,
          path: result.path,
          operation: result.operation,
        });

        return createToolResponse(`${result.content}\n\n---\n${metadata}`);
      },
    },
    vaults,
  );
}
