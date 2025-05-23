import { z } from "zod";
import { FileOperationResult } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  ensureMarkdownExtension,
  validateVaultPath,
} from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";
import { parseNote, stringifyNote } from "../../utils/tags.js";

// Schema for edit operations
const editSchema = z
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
        "Path of the note relative to vault root (e.g., 'folder/note.md')",
      ),
    operation: z
      .enum(["append", "prepend", "replace"])
      .describe(
        "Type of edit operation - must be one of: 'append', 'prepend', 'replace'",
      ),
    content: z
      .string()
      .min(1, "Content cannot be empty")
      .describe("New content to add/prepend/replace"),
  })
  .strict();

// Use only editSchema now
const schema = editSchema;

// Types
type EditOperation = "append" | "prepend" | "replace";

// Define the input type based on the schema
type EditNoteInput = z.infer<typeof schema>;

async function editNote(
  vaultPath: string,
  notePath: string,
  operation: EditOperation,
  content: string,
): Promise<FileOperationResult> {
  // Apply MD extension check here
  const sanitizedPath = ensureMarkdownExtension(notePath);
  const fullPath = path.join(vaultPath, sanitizedPath);

  // Validate path is within vault
  validateVaultPath(vaultPath, fullPath);

  // Check if file exists first
  if (!(await fileExists(fullPath))) {
    throw createNoteNotFoundError(notePath);
  }

  // Create unique backup filename
  const timestamp = Date.now();
  const backupPath = `${fullPath}.${timestamp}.backup`;

  try {
    // Create backup
    await fs.copyFile(fullPath, backupPath);

    // Read existing content
    const existingContent = await fs.readFile(fullPath, "utf-8");

    // Prepare new content based on operation
    let finalContentToWrite: string;
    const trimmedExisting = existingContent.trim();
    const trimmedContent = content.trim();

    switch (operation) {
      case "append":
        // Append: Add new content after existing content
        finalContentToWrite = trimmedExisting
          ? `${trimmedExisting}\n\n${trimmedContent}`
          : trimmedContent;
        break;

      case "prepend":
        // Prepend: Add new content before existing content
        finalContentToWrite = trimmedExisting
          ? `${trimmedContent}\n\n${trimmedExisting}`
          : trimmedContent;
        break;

      case "replace":
        // Replace: Parse existing, replace content body, keep frontmatter
        const parsedNote = parseNote(existingContent);
        parsedNote.content = trimmedContent;
        finalContentToWrite = stringifyNote(parsedNote);
        break;

      default:
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid operation: ${operation}`,
        );
    }

    // Write the final content
    await fs.writeFile(fullPath, finalContentToWrite);

    // Clean up backup on success
    await fs.unlink(backupPath);

    // Form past tense for the message
    const pastTenseOperation =
      operation === "replace" ? "replaced" : `${operation}ed`;

    return {
      success: true,
      message: `Note ${pastTenseOperation} successfully`,
      path: fullPath,
      operation: "edit",
    };
  } catch (error: unknown) {
    // Attempt to restore from backup
    try {
      if (await fileExists(backupPath)) {
        await fs.copyFile(backupPath, fullPath);
        await fs.unlink(backupPath);
      }
    } catch (rollbackError) {
      // If rollback fails, preserve backup and include both errors
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const rollbackErrorMessage =
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);

      throw new McpError(
        ErrorCode.InternalError,
        `Failed to rollback changes. Original error: ${errorMessage}. Rollback error: ${rollbackErrorMessage}. Backup preserved at ${backupPath}`,
      );
    }

    // Re-throw original error after successful rollback
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, `${operation} note`);
  }
}

export function createEditNoteTool(vaults: Map<string, string>) {
  return createTool<EditNoteInput>(
    {
      name: "edit-note",
      description: `Edit an existing note in the specified vault.
Supports appending, prepending, or replacing the entire note content.

Examples:
- Append: { "vault": "vault1", "path": "note.md", "operation": "append", "content": "new content" }
- Prepend: { "vault": "vault1", "path": "note.md", "operation": "prepend", "content": "prepended text" }
- Replace: { "vault": "vault2", "path": "journal/2024/note.md", "operation": "replace", "content": "replacement content" }`,
      schema,
      handler: async (args, vaultPath, _vaultName) => {
        // Pass args.path directly
        const result = await editNote(
          vaultPath,
          args.path,
          args.operation,
          args.content,
        );
        return createToolResponse(formatFileResult(result));
      },
    },
    vaults,
  );
}
