import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { handleFsError } from "../../utils/errors.js";
import { createToolResponse } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";
import {
  ensureMarkdownExtension,
  validateVaultPath,
} from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";

// --- Input Schema ---
const schema = z
  .object({
    vault: z
      .string()
      .min(1, "Vault name cannot be empty")
      .describe("Name of the vault containing the note"),
    path: z
      .string()
      .min(1, "Note path cannot be empty")
      .refine(
        (name) => !path.isAbsolute(name),
        "Path must be relative to vault root",
      )
      .transform(ensureMarkdownExtension)
      .describe(
        "Relative path of the note containing the task (e.g., 'folder/note.md')",
      ),
    line: z
      .number()
      .int()
      .positive("Line number must be a positive integer")
      .describe(
        "The 1-based line number of the task to toggle (e.g., obtained from get-tasks-in-note)",
      ),
  })
  .strict();

type ToggleTaskInput = z.infer<typeof schema>;

// --- Core Logic ---
async function toggleTaskStatus(
  args: ToggleTaskInput,
  vaultPath: string,
): Promise<{ success: boolean; message: string }> {
  const noteRelPath = args.path;
  const noteAbsPath = path.join(vaultPath, noteRelPath);
  const targetLineNumber = args.line; // 1-based

  validateVaultPath(vaultPath, noteAbsPath);
  if (!(await fileExists(noteAbsPath))) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Note not found: ${noteRelPath}`,
    );
  }

  try {
    const content = await fs.readFile(noteAbsPath, "utf8");
    const lines = content.split(/\r?\n/); // Split by newline

    // Validate line number
    if (targetLineNumber <= 0 || targetLineNumber > lines.length) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid line number: ${targetLineNumber}. Note has ${lines.length} lines.`,
      );
    }

    const lineIndex = targetLineNumber - 1; // Convert to 0-based index
    const lineContent = lines[lineIndex];

    // Regex to find the checkbox part of a task line
    const taskRegex = /^(\s*- \[)([ x])(] .*)/;
    const match = lineContent.match(taskRegex);

    if (!match) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Line ${targetLineNumber} is not a valid Markdown task: "${lineContent.substring(0, 50)}..."`,
      );
    }

    // Toggle the state
    const currentState = match[2]; // ' ' or 'x'
    const newState = currentState === " " ? "x" : " ";
    const newLineContent = match[1] + newState + match[3];

    // Update the specific line
    lines[lineIndex] = newLineContent;

    // Write the modified content back
    await fs.writeFile(noteAbsPath, lines.join("\n"), "utf8");

    const statusText = newState === "x" ? "completed" : "incomplete";
    return {
      success: true,
      message: `Task on line ${targetLineNumber} in '${noteRelPath}' marked as ${statusText}.`,
    };
  } catch (error: any) {
    if (error instanceof McpError) {
      throw error;
    }
    // Handle file I/O or other unexpected errors
    throw handleFsError(error, "toggle task status");
  }
}

// --- Tool Factory ---
export function createToggleTaskTool(vaults: Map<string, string>) {
  return createTool<ToggleTaskInput>(
    {
      name: "toggle-task",
      description: `Toggles the completion status of a basic Markdown task (- [ ] <-> - [x]) on a specific line within a note.

Requires the exact line number, typically obtained from 'get-tasks-in-note'.

Examples:
- Toggle task on line 5: { "vault": "my_vault", "path": "todos.md", "line": 5 }`,
      schema,
      handler: async (args, vaultPath, _vaultName) => {
        try {
          const result = await toggleTaskStatus(args, vaultPath);
          return createToolResponse(result.message);
        } catch (error: any) {
          if (error instanceof McpError) {
            throw error;
          }
          console.error(
            `Error toggling task in '${args.path}' (line ${args.line}) in vault '${args.vault}':`,
            error,
          );
          throw handleFsError(error, "toggle task");
        }
      },
    },
    vaults,
  );
}
