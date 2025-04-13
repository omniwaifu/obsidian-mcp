import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { handleFsError } from "../../utils/errors.js";
import { createToolResponse } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";
import { ensureMarkdownExtension } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";

// --- Cache Setup ---
interface CachedConfig {
    config: DailyNotesConfig;
    timestamp: number;
}
const dailyNoteConfigCache = new Map<string, CachedConfig>();
const CACHE_DURATION_MS = 60 * 1000; // Cache for 60 seconds

// --- Configuration Interfaces ---
interface DailyNotesConfig {
  folder?: string;
  format?: string;
  template?: string;
  autorun?: boolean;
}

// --- Input Schema ---
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault to get the daily note path for"),
}).strict();

type GetDailyNotePathInput = z.infer<typeof schema>;

// --- Simple Date Formatter ---
function formatSimpleDate(date: Date, formatString: string): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1; // JS months are 0-indexed
    const day = date.getDate();

    let formatted = formatString;
    formatted = formatted.replace(/YYYY/g, String(year));
    formatted = formatted.replace(/MM/g, String(month).padStart(2, '0'));
    formatted = formatted.replace(/M/g, String(month));
    formatted = formatted.replace(/DD/g, String(day).padStart(2, '0'));
    formatted = formatted.replace(/D/g, String(day));

    if (formatString.includes('W')) {
        const tempDate = new Date(date.valueOf());
        tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
        const week1 = new Date(tempDate.getFullYear(), 0, 4);
        const weekNumber = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
        formatted = formatted.replace(/WW/g, String(weekNumber).padStart(2, '0'));
        formatted = formatted.replace(/W/g, String(weekNumber));
    }
    
    // Check if any Moment-like tokens remain after our replacements
    const remainingTokens = formatted.replace(/[^YMDW]/g, ''); // Remove non-token chars
    if (/[YMDW]/i.test(remainingTokens)) { // Case-insensitive check for remaining Y, M, D, W
       throw new McpError(ErrorCode.InvalidParams, `Daily note format "${formatString}" contains unsupported formatting tokens.`);
    }

    return formatted;
}

// --- Core Logic ---
async function getDailyNotePath(
  args: GetDailyNotePathInput,
  vaultPath: string,
  vaultName: string // Need vaultName for caching key
): Promise<{ path: string }> {
  const now = Date.now();
  const cachedEntry = dailyNoteConfigCache.get(vaultName);
  let config: DailyNotesConfig;

  // Check cache validity
  if (cachedEntry && (now - cachedEntry.timestamp < CACHE_DURATION_MS)) {
    config = cachedEntry.config;
  } else {
    // Cache miss or expired
    const configFilePath = path.join(vaultPath, '.obsidian', 'daily-notes.json');
    try {
      const content = await fs.readFile(configFilePath, 'utf8');
      config = JSON.parse(content) as DailyNotesConfig;
      // Update cache
      dailyNoteConfigCache.set(vaultName, { config, timestamp: now });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Don't cache if file not found, but throw error
        throw new McpError(ErrorCode.InvalidParams, "Daily Notes configuration file (daily-notes.json) not found in .obsidian folder. Is the plugin enabled and configured?");
      }
      if (error instanceof SyntaxError) {
        // Don't cache if parsing fails
        throw new McpError(ErrorCode.InternalError, `Error parsing daily-notes.json: ${error.message}`);
      }
      // Don't cache for other read errors
      throw handleFsError(error, 'read daily notes config');
    }
  }

  // Proceed with using the config (either cached or freshly read)
  if (!config.format) {
      // If config is invalid (e.g., missing format), potentially invalidate cache?
      // For now, we just throw. If the file *was* read, it would have been cached above.
      // If it came from cache, it implies it was valid previously.
      dailyNoteConfigCache.delete(vaultName); // Invalidate cache if format missing
      throw new McpError(ErrorCode.InvalidRequest, "Daily notes configuration is missing the 'format' field.");
  }
  const folder = config.folder || ''; 

  const today = new Date();
  let formattedDate: string;
  try {
      formattedDate = formatSimpleDate(today, config.format);
  } catch (formatError) {
      // If formatting fails with cached config, invalidate cache
      if (cachedEntry) { dailyNoteConfigCache.delete(vaultName); }
      if (formatError instanceof McpError) throw formatError;
      throw new McpError(ErrorCode.InvalidParams, `Failed to format date using format string "${config.format}": ${(formatError as Error).message}`);
  }

  // Ensure folder path separators are handled correctly for joining
  const folderPart = folder.endsWith('/') ? folder.slice(0, -1) : folder;
  const joinedPath = folderPart ? path.join(folderPart, formattedDate) : formattedDate;

  const finalPath = ensureMarkdownExtension(joinedPath);

  return { path: finalPath };
}

// --- Tool Factory ---
export function createGetDailyNotePathTool(vaults: Map<string, string>) {
  return createTool<GetDailyNotePathInput>({
    name: "get-daily-note-path",
    description: `Calculates the expected relative path for today's daily note based on the Daily Notes core plugin settings (.obsidian/daily-notes.json).\n\nExamples:\n- Get path for vault: { "vault": "my_vault" }`,
    schema,
    handler: async (args, vaultPath, vaultName) => {
      try {
        // Pass vaultName to the core logic function for caching
        const result = await getDailyNotePath(args, vaultPath, vaultName);
        return {
          type: "json",
          data: { path: result.path }
        };
      } catch (error: any) {
         if (error instanceof McpError) {
           throw error;
         }
        console.error(`Error getting daily note path for vault '${args.vault}':`, error);
        throw handleFsError(error, 'get daily note path');
      }
    }
  }, vaults);
} 