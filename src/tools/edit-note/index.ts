import { z } from "zod";
import { FileOperationResult } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// Schema for edit operations
const editSchema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault containing the note"),
  filename: z.string()
    .min(1, "Filename cannot be empty")
    .refine(name => !name.includes('/') && !name.includes('\\'),
      "Filename cannot contain path separators - use the 'folder' parameter for paths instead")
    .describe("Just the note name without any path separators (e.g. 'my-note.md', NOT 'folder/my-note.md')"),
  folder: z.string()
    .optional()
    .refine(folder => !folder || !path.isAbsolute(folder),
      "Folder must be a relative path")
    .describe("Optional subfolder path relative to vault root"),
  operation: z.enum(['append', 'prepend', 'replace'])
    .describe("Type of edit operation - must be one of: 'append', 'prepend', 'replace'")
    .refine(
      (op) => ['append', 'prepend', 'replace'].includes(op),
      {
        message: "Invalid operation. Must be one of: 'append', 'prepend', 'replace'",
        path: ['operation']
      }
    ),
  content: z.string()
    .min(1, "Content cannot be empty")
    .describe("New content to add/prepend/replace")
}).strict();

// Use only editSchema now
const schema = editSchema;

// Types
type EditOperation = 'append' | 'prepend' | 'replace';

async function editNote(
  vaultPath: string,
  filename: string,
  operation: EditOperation,
  content: string,
  folder?: string
): Promise<FileOperationResult> {
  const sanitizedFilename = ensureMarkdownExtension(filename);
  const fullPath = folder
    ? path.join(vaultPath, folder, sanitizedFilename)
    : path.join(vaultPath, sanitizedFilename);

  // Validate path is within vault
  validateVaultPath(vaultPath, fullPath);

  // Create unique backup filename
  const timestamp = Date.now();
  const backupPath = `${fullPath}.${timestamp}.backup`;

  try {
    // Create backup first
    if (await fileExists(fullPath)) {
      await fs.copyFile(fullPath, backupPath);
    } else {
      throw createNoteNotFoundError(filename);
    }

    switch (operation) {
      case 'append':
      case 'prepend':
      case 'replace': {
        try {
          // Read existing content
          const existingContent = await fs.readFile(fullPath, "utf-8");

          // Prepare new content based on operation
          let newContent: string;
          if (operation === 'append') {
            newContent = existingContent.trim() + (existingContent.trim() ? '\n\n' : '') + content;
          } else if (operation === 'prepend') {
            newContent = content + (existingContent.trim() ? '\n\n' : '') + existingContent.trim();
          } else {
            // replace
            newContent = content;
          }

          // Write the new content
          await fs.writeFile(fullPath, newContent);

          // Clean up backup on success
          await fs.unlink(backupPath);

          return {
            success: true,
            message: `Note ${operation}ed successfully`,
            path: fullPath,
            operation: 'edit'
          };
        } catch (error: unknown) {
          // On error, attempt to restore from backup
          if (await fileExists(backupPath)) {
            try {
              await fs.copyFile(backupPath, fullPath);
              await fs.unlink(backupPath);
            } catch (rollbackError: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              const rollbackErrorMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);

              throw new McpError(
                ErrorCode.InternalError,
                `Failed to rollback changes. Original error: ${errorMessage}. Rollback error: ${rollbackErrorMessage}. Backup file preserved at ${backupPath}`
              );
            }
          }
          throw error;
        }
      }

      default: {
        const _exhaustiveCheck: never = operation;
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid operation: ${operation}`
        );
      }
    }
  } catch (error: unknown) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, `${operation} note`);
  }
}

type EditNoteArgs = z.infer<typeof schema>;

export function createEditNoteTool(vaults: Map<string, string>) {
  return createTool<EditNoteArgs>({
    name: "edit-note",
    description: `Edit an existing note in the specified vault.
Supports appending, prepending, or replacing the entire note content.

Examples:
- Append: { "vault": "vault1", "filename": "note.md", "operation": "append", "content": "new content" }
- Prepend: { "vault": "vault1", "filename": "note.md", "operation": "prepend", "content": "prepended text" }
- Replace: { "vault": "vault2", "filename": "note.md", "folder": "journal/2024", "operation": "replace", "content": "replacement content" }
- INCORRECT: { "filename": "journal/2024/note.md" } (don't put path in filename)`,
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      const result = await editNote(
        vaultPath,
        args.filename,
        args.operation,
        args.content,
        args.folder
      );
      return createToolResponse(formatFileResult(result));
    }
  }, vaults);
}
