import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatBookmarksResult } from "../../utils/responses.js"; // Assuming formatBookmarksResult will be added
import { createTool } from "../../utils/tool-factory.js";

// Define expected structure of a bookmark item based on user example
interface BookmarkItem {
  type: string;       // e.g., "file", "search", "group", "heading", "block"
  ctime?: number;     // Creation time (optional)
  path?: string;      // Path for 'file', 'heading', 'block' types
  query?: string;     // Query for 'search' type
  title?: string;     // User-defined title or derived name
  items?: BookmarkItem[]; // For 'group' type
}

// Define the overall structure of bookmarks.json
interface BookmarksFile {
  items: BookmarkItem[];
}

// Input validation schema
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault to read bookmarks from"),
}).strict();

type ListBookmarksInput = z.infer<typeof schema>;

async function readBookmarks(
  _args: ListBookmarksInput, // Vault name is used to find vaultPath
  vaultPath: string
): Promise<BookmarksFile> {
  const bookmarksFilePath = path.join(vaultPath, '.obsidian', 'bookmarks.json');

  try {
    const content = await fs.readFile(bookmarksFilePath, 'utf8');
    const bookmarksData = JSON.parse(content) as BookmarksFile;
    
    // Basic validation of the parsed structure
    if (!bookmarksData || !Array.isArray(bookmarksData.items)) {
        throw new Error("Invalid bookmarks.json structure: 'items' array not found or invalid.");
    }
    
    return bookmarksData;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // File not found is not an error, just means no bookmarks (or plugin disabled)
      return { items: [] }; // Return empty list
    }
    if (error instanceof SyntaxError) {
        throw new McpError(ErrorCode.InternalError, `Error parsing bookmarks.json: ${error.message}`);
    }
    // Rethrow other file system or unexpected errors, wrapped
    throw handleFsError(error, 'read bookmarks file');
  }
}

export function createListBookmarksTool(vaults: Map<string, string>) {
  return createTool<ListBookmarksInput>({
    name: "list-bookmarks",
    description: `List all items bookmarked in the specified vault's Bookmarks core plugin data (.obsidian/bookmarks.json).

Examples:
- List bookmarks for vault: { "vault": "my_vault" }`,
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      try {
        const result = await readBookmarks(args, vaultPath);
        // Format the result using a helper function (to be created)
        const message = formatBookmarksResult(result);
        return createToolResponse(message);
      } catch (error: any) {
         if (error instanceof McpError) {
           throw error;
         }
        console.error(`Error listing bookmarks for vault '${args.vault}':`, error);
        throw handleFsError(error, 'list bookmarks');
      }
    }
  }, vaults);
} 