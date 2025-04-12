import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { FileOperationResult } from "../../types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists, safeReadFile } from "../../utils/files.js";
import { parseNote, stringifyNote } from "../../utils/tags.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault containing the note"),
  path: z.string()
    .min(1, "Path cannot be empty")
    .refine(name => !path.isAbsolute(name),
      "Path must be relative to vault root")
    .describe("Path of the note relative to vault root (e.g., 'folder/note.md')"),
  alias: z.string()
    .min(1, "Alias cannot be empty")
    .describe("The alias string to add")
}).strict();

type AddAliasInput = z.infer<typeof schema>;

async function addAlias(
  vaultPath: string,
  notePath: string,
  alias: string
): Promise<FileOperationResult> {
  const sanitizedPath = ensureMarkdownExtension(notePath);
  const fullPath = path.join(vaultPath, sanitizedPath);

  validateVaultPath(vaultPath, fullPath);

  try {
    const content = await safeReadFile(fullPath);
    if (content === undefined) {
      throw createNoteNotFoundError(notePath);
    }

    const parsedNote = parseNote(content);

    // Ensure aliases key exists and is an array
    if (!parsedNote.frontmatter.aliases) {
      parsedNote.frontmatter.aliases = [];
    } else if (!Array.isArray(parsedNote.frontmatter.aliases)) {
      // If aliases exists but isn't an array, attempt to convert or overwrite
      // For simplicity, we'll overwrite here, assuming user intent is to manage aliases as an array.
      console.warn(`Frontmatter key 'aliases' in ${notePath} was not an array. Overwriting.`);
      parsedNote.frontmatter.aliases = [];
    }

    // Add alias if it doesn't already exist (case-sensitive check)
    if (!parsedNote.frontmatter.aliases.includes(alias)) {
      parsedNote.frontmatter.aliases.push(alias);
      // Keep aliases sorted for consistency
      parsedNote.frontmatter.aliases.sort();
      parsedNote.hasFrontmatter = true; // Ensure frontmatter block is created if it wasn't there

      const updatedContent = stringifyNote(parsedNote);

      // Check if content actually changed before writing
      if (updatedContent !== content) {
         await fs.writeFile(fullPath, updatedContent, 'utf8');
         return {
           success: true,
           message: `Successfully added alias "${alias}"`,
           path: fullPath,
           operation: 'edit' // Considered an edit operation
         };
      } else {
         // Alias might already exist in a different case or normalization resulted in no change
         return {
           success: true, // Technically success, no change needed
           message: `Alias "${alias}" already exists or resulted in no change`,
           path: fullPath,
           operation: 'edit'
         };
      }

    } else {
      // Alias already exists
      return {
        success: true, // Success, no action needed
        message: `Alias "${alias}" already exists`,
        path: fullPath,
        operation: 'edit'
      };
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'add alias');
  }
}

export function createAddAliasTool(vaults: Map<string, string>) {
  return createTool<AddAliasInput>({
    name: "add-alias",
    description: "Add an alias to a note's frontmatter.",
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      const result = await addAlias(vaultPath, args.path, args.alias);
      return createToolResponse(formatFileResult(result));
    }
  }, vaults);
} 