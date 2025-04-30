import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { FileOperationResult } from "../../types.js";
import {
  ensureMarkdownExtension,
  validateVaultPath,
} from "../../utils/path.js";
import { fileExists, safeReadFile } from "../../utils/files.js";
import { parseNote, stringifyNote } from "../../utils/tags.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

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
        "Path of the note relative to vault root (e.g., 'folder/note.md')",
      ),
    alias: z
      .string()
      .min(1, "Alias cannot be empty")
      .describe("The alias string to remove"),
  })
  .strict();

type RemoveAliasInput = z.infer<typeof schema>;

async function removeAlias(
  vaultPath: string,
  notePath: string,
  aliasToRemove: string,
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

    // Check if aliases key exists and is an array
    if (
      !parsedNote.frontmatter.aliases ||
      !Array.isArray(parsedNote.frontmatter.aliases)
    ) {
      // No aliases exist, so the one to remove isn't there
      return {
        success: true,
        message: `Alias "${aliasToRemove}" not found (no aliases defined)`,
        path: fullPath,
        operation: "edit",
      };
    }

    const initialLength = parsedNote.frontmatter.aliases.length;
    // Filter out the alias (case-sensitive)
    parsedNote.frontmatter.aliases = parsedNote.frontmatter.aliases.filter(
      (alias: string) => alias !== aliasToRemove,
    );

    if (parsedNote.frontmatter.aliases.length < initialLength) {
      // Alias was removed

      // If aliases array is now empty, remove the key for cleanliness
      if (parsedNote.frontmatter.aliases.length === 0) {
        delete parsedNote.frontmatter.aliases;
        // If frontmatter becomes empty, ensure hasFrontmatter reflects this?
        // stringifyNote currently handles empty frontmatter objects correctly.
      }

      const updatedContent = stringifyNote(parsedNote);
      await fs.writeFile(fullPath, updatedContent, "utf8");

      return {
        success: true,
        message: `Successfully removed alias "${aliasToRemove}"`,
        path: fullPath,
        operation: "edit",
      };
    } else {
      // Alias was not found in the array
      return {
        success: true, // Success, no action needed
        message: `Alias "${aliasToRemove}" not found in the list`,
        path: fullPath,
        operation: "edit",
      };
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, "remove alias");
  }
}

export function createRemoveAliasTool(vaults: Map<string, string>) {
  return createTool<RemoveAliasInput>(
    {
      name: "remove-alias",
      description: "Remove an alias from a note's frontmatter.",
      schema,
      handler: async (args, vaultPath, _vaultName) => {
        const result = await removeAlias(vaultPath, args.path, args.alias);
        return createToolResponse(formatFileResult(result));
      },
    },
    vaults,
  );
}
