import { z } from "zod";
import { FileOperationResult } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { ensureDirectory, fileExists } from "../../utils/files.js";
import { createNoteExistsError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema with descriptions
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault to create the note in"),
  path: z.string()
    .min(1, "Path cannot be empty")
    .refine(name => !path.isAbsolute(name),
      "Path must be relative to vault root")
    .describe("Path of the note relative to vault root (e.g., 'folder/note.md'). Will add .md extension if missing"),
  content: z.string()
    .min(1, "Content cannot be empty")
    .describe("Content of the note in markdown format")
}).strict();

type CreateNoteInput = z.infer<typeof schema>;

async function createNote(
  args: CreateNoteInput, // Use the inferred type directly
  vaultPath: string
): Promise<FileOperationResult> {
  // Apply MD extension check here
  const sanitizedPath = ensureMarkdownExtension(args.path);
  const notePath = path.join(vaultPath, sanitizedPath);

  // Validate path is within vault
  validateVaultPath(vaultPath, notePath);

  try {
    // Create directory structure if needed
    const noteDir = path.dirname(notePath);
    await ensureDirectory(noteDir);

    // Check if file exists first
    if (await fileExists(notePath)) {
      // Use the relative path in the error
      throw createNoteExistsError(args.path);
    }

    // File doesn't exist, proceed with creation
    await fs.writeFile(notePath, args.content, 'utf8');
    
    return {
      success: true,
      message: "Note created successfully",
      path: notePath,
      operation: 'create'
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'create note');
  }
}

export function createCreateNoteTool(vaults: Map<string, string>) {
  return createTool<CreateNoteInput>({
    name: "create-note",
    description: `Create a new note in the specified vault with markdown content.

Examples:
- Root note: { "vault": "vault1", "path": "note.md", "content": "..." }
- Subfolder note: { "vault": "vault2", "path": "journal/2024/note.md", "content": "..." }`,
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      // Pass args directly
      const result = await createNote(args, vaultPath);
      // Ensure consistent response format
      return createToolResponse(formatFileResult(result));
    }
  }, vaults);
}
