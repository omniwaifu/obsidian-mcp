import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { handleFsError } from "../../utils/errors.js";
import {
  createToolResponse,
  formatTasksResult,
} from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";
import {
  ensureMarkdownExtension,
  validateVaultPath,
} from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";

// --- Task Definition ---
// Exporting this interface might be useful if other tools need it
export interface TaskItem {
  text: string;
  checked: boolean;
  line: number; // 1-based line number
}

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
        "Relative path of the note to search for tasks (e.g., 'folder/note.md')",
      ),
  })
  .strict();

type GetTasksInput = z.infer<typeof schema>;

// --- Core Logic ---
async function findTasksInNote(
  args: GetTasksInput,
  vaultPath: string,
): Promise<{ tasks: TaskItem[] }> {
  const noteRelPath = args.path;
  const noteAbsPath = path.join(vaultPath, noteRelPath);

  validateVaultPath(vaultPath, noteAbsPath);
  if (!(await fileExists(noteAbsPath))) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Note not found: ${noteRelPath}`,
    );
  }

  const tasks: TaskItem[] = [];
  try {
    const content = await fs.readFile(noteAbsPath, "utf8");
    const lines = content.split(/\r?\n/);

    // Regex to match basic markdown tasks: - [ ] or - [x]
    const taskRegex = /^\s*- \[([ x])] (.*)/;

    lines.forEach((lineText, index) => {
      const match = lineText.match(taskRegex);
      if (match) {
        tasks.push({
          text: match[2].trim(),
          checked: match[1].toLowerCase() === "x",
          line: index + 1, // 1-based line number
        });
      }
    });

    return { tasks };
  } catch (error: any) {
    throw handleFsError(error, "read note for tasks");
  }
}

// --- Tool Factory (Ensure this is exported) ---
export function createGetTasksInNoteTool(vaults: Map<string, string>) {
  return createTool<GetTasksInput>(
    {
      name: "get-tasks-in-note",
      description: `Finds and lists all basic Markdown tasks (- [ ] or - [x]) within a specified note.\n\nExamples:\n- Get tasks from note: { "vault": "my_vault", "path": "todos.md" }`,
      schema,
      handler: async (args, vaultPath, _vaultName) => {
        try {
          const result = await findTasksInNote(args, vaultPath);
          // Use the imported formatter function
          const message = formatTasksResult(result, args.path);
          return createToolResponse(message);
        } catch (error: any) {
          if (error instanceof McpError) {
            throw error;
          }
          console.error(
            `Error getting tasks from note '${args.path}' in vault '${args.vault}':`,
            error,
          );
          throw handleFsError(error, "get tasks from note");
        }
      },
    },
    vaults,
  );
}
