import { z } from "zod";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { FileOperationResult } from "../../types.js"; // Although not strictly a FileOp, use for consistency?
import {
  ensureMarkdownExtension,
  validateVaultPath,
} from "../../utils/path.js";
import { safeReadFile } from "../../utils/files.js";
import { parseNote } from "../../utils/tags.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createToolResponse } from "../../utils/responses.js";
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
  })
  .strict();

type ListAliasesInput = z.infer<typeof schema>;

// Return type for the core logic
interface ListAliasesResult {
  success: boolean;
  message: string;
  aliases: string[];
}

async function listAliases(
  vaultPath: string,
  notePath: string,
): Promise<ListAliasesResult> {
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
      parsedNote.frontmatter.aliases &&
      Array.isArray(parsedNote.frontmatter.aliases)
    ) {
      return {
        success: true,
        message: `Found ${parsedNote.frontmatter.aliases.length} alias(es)`,
        aliases: parsedNote.frontmatter.aliases,
      };
    } else {
      // No aliases defined or key is not an array
      return {
        success: true,
        message: "No aliases found for this note",
        aliases: [],
      };
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    // Rethrow other errors to be handled by the factory
    throw handleFsError(error, "list aliases");
  }
}

export function createListAliasesTool(vaults: Map<string, string>) {
  return createTool<ListAliasesInput>(
    {
      name: "list-aliases",
      description: "List the aliases defined in a note's frontmatter.",
      schema,
      handler: async (args, vaultPath, _vaultName) => {
        const result = await listAliases(vaultPath, args.path);
        // Format the response message
        let responseMessage = result.message;
        if (result.aliases.length > 0) {
          responseMessage += `:\n- ${result.aliases.join("\n- ")}`;
        }
        return createToolResponse(responseMessage);
      },
    },
    vaults,
  );
}
