import { z } from "zod";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getAllNonMarkdownFiles } from "../../utils/files.js";
import { normalizePath, safeJoinPath } from "../../utils/path.js"; // Use for path arg validation
import { createToolResponse } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

const schema = z
  .object({
    vault: z
      .string()
      .min(1, "Vault name cannot be empty")
      .describe("Name of the vault to list files from"),
    path: z
      .string()
      .optional()
      .refine(
        (dirPath) => !dirPath || !path.isAbsolute(dirPath),
        "Directory path must be relative to vault root",
      )
      .describe(
        "Optional sub-directory path within the vault to list files from (relative to vault root)",
      ),
  })
  .strict();

type ListFilesInput = z.infer<typeof schema>;

async function listFiles(
  vaultPath: string,
  subPath?: string,
): Promise<string[]> {
  const targetDir = subPath ? safeJoinPath(vaultPath, subPath) : vaultPath;
  // getAllNonMarkdownFiles already validates targetDir is within vaultPath
  const files = await getAllNonMarkdownFiles(vaultPath, targetDir);
  // Return relative paths
  return files.map((fullPath) => path.relative(vaultPath, fullPath));
}

export function createListFilesTool(vaults: Map<string, string>) {
  return createTool<ListFilesInput>(
    {
      name: "list-files",
      description:
        "Lists non-Markdown files (like images, PDFs) in the vault or a specific folder.",
      schema,
      handler: async (args, vaultPath, _vaultName) => {
        const files = await listFiles(vaultPath, args.path);

        let responseMessage: string;
        if (files.length === 0) {
          const scope = args.path ? ` in '${args.path}'` : "";
          responseMessage = `No non-Markdown files found${scope}.`;
        } else {
          const scope = args.path ? ` in '${args.path}'` : "";
          responseMessage = `Found ${files.length} non-Markdown file(s)${scope}:\n- ${files.join("\n- ")}`;
        }

        return createToolResponse(responseMessage);
      },
    },
    vaults,
  );
}
