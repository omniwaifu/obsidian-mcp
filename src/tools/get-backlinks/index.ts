import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { validateVaultPath, ensureMarkdownExtension } from "../../utils/path.js";
import { handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatBacklinksResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";
import { fileExists } from "../../utils/files.js";

// Input validation schema
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault to search for backlinks in"),
  path: z.string()
    .min(1, "Target note path cannot be empty")
    .refine(name => !path.isAbsolute(name),
      "Path must be relative to vault root")
    .transform(ensureMarkdownExtension) // Ensure .md extension
    .describe("Relative path of the target note (e.g., 'folder/note.md') to find backlinks for. Will add .md if missing."),
}).strict();

type GetBacklinksInput = z.infer<typeof schema>;

// Define the structure for the output
interface BacklinksResult {
    backlinks: string[]; // List of relative paths of notes linking to the target
}

// Function to escape regex special characters
function escapeRegex(string: string): string {
    // Escape characters with special meaning in regex
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

// Recursive function to find all markdown files
async function findAllMarkdownFiles(dirPath: string, vaultRoot: string): Promise<string[]> {
    let files: string[] = [];
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });

    for (const dirent of dirents) {
        const fullPath = path.join(dirPath, dirent.name);
        const relativePath = path.relative(vaultRoot, fullPath);

        // Skip common ignored directories
        if (dirent.isDirectory() && (dirent.name === '.obsidian' || dirent.name === '.git' || dirent.name === 'node_modules')) {
            continue;
        }

        if (dirent.isDirectory()) {
            // Recursively search subdirectories
            files = files.concat(await findAllMarkdownFiles(fullPath, vaultRoot));
        } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
            // Add relative path of markdown files
            files.push(relativePath);
        }
    }
    return files;
}

async function findBacklinks(
  args: GetBacklinksInput,
  vaultPath: string
): Promise<BacklinksResult> {
  const targetRelPath = args.path; // Already has .md extension
  const targetAbsPath = path.join(vaultPath, targetRelPath);

  // 1. Validate target path exists within the vault
  validateVaultPath(vaultPath, targetAbsPath);
  if (!(await fileExists(targetAbsPath))) {
      throw new McpError(ErrorCode.InvalidParams, `Target note not found: ${targetRelPath}`);
  }

  // 2. Prepare link patterns based on target note path and name
  const targetBaseName = path.basename(targetRelPath, '.md');
  const targetRelPathNoExt = targetRelPath.replace(/\\.md$/, '');

  // Create an array of patterns to look for inside [[...]]
  const linkPatterns = [
      escapeRegex(targetRelPath),      // Full relative path with extension: [[Folder/Note Name.md]]
      escapeRegex(targetRelPathNoExt), // Full relative path without extension: [[Folder/Note Name]]
      escapeRegex(targetBaseName)       // Just the base name: [[Note Name]]
  ];

  // Construct the regex to find wikilinks pointing to the target.
  const backlinkRegex = new RegExp(
      `(?<!\\\`)\\\\[\\\\[(${linkPatterns.join('|')})(\\\\|[^\\\\]]+)?\\\\]\\\\](?!\\\`)`,
      'g' // Global flag to find all matches
  );

  // 3. Find all markdown files recursively
  const allMdFiles = await findAllMarkdownFiles(vaultPath, vaultPath);

  // 4. Scan each file for links matching the regex
  const backlinksFound = new Set<string>();

  for (const sourceRelPath of allMdFiles) {
    // Ensure the source and target are not the same file
    if (path.normalize(sourceRelPath) === path.normalize(targetRelPath)) {
        continue;
    }

    const sourceAbsPath = path.join(vaultPath, sourceRelPath);
    try {
        const content = await fs.readFile(sourceAbsPath, 'utf8');
        // Reset lastIndex for global regex before each test
        backlinkRegex.lastIndex = 0;
        if (backlinkRegex.test(content)) {
            // If a match is found, add the source file's relative path
            backlinksFound.add(sourceRelPath);
        }
    } catch (error) {
        // Log errors reading individual files but continue scanning others
        console.error(`Error reading file ${sourceRelPath}: ${error}`);
    }
  }

  // Return the unique list of files containing backlinks
  return { backlinks: Array.from(backlinksFound) };
}

// Export the tool factory function
export function createGetBacklinksTool(vaults: Map<string, string>) {
  return createTool<GetBacklinksInput>({
    name: "get-backlinks",
    description: `Find all notes within a vault that contain links pointing to the specified target note.\\nNote: This tool uses pattern matching and might include links intended for other notes if names are ambiguous or links appear inside code blocks.\\n\\nExamples:\\n- Find backlinks for root note: { "vault": "my_vault", "path": "note.md" }\\n- Find backlinks for note in folder: { "vault": "another_vault", "path": "meetings/2024-01-01.md" }`,
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      try {
        // Call the core backlink finding logic
        const result = await findBacklinks(args, vaultPath);
        // Format the successful response using the new helper
        const message = formatBacklinksResult(result, args.path);
        return createToolResponse(message);
      } catch (error: any) {
         // Rethrow known MCP errors
         if (error instanceof McpError) {
           throw error;
         }
         // Log unexpected errors and wrap them
        console.error(`Error finding backlinks for ${args.path}:`, error);
        throw handleFsError(error, 'find backlinks');
      }
    }
  }, vaults);
} 