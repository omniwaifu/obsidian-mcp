import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { handleFsError } from "../../utils/errors.js";
import { createToolResponse } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";
import { ensureMarkdownExtension } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";

// --- Configuration Interfaces ---
interface DailyNotesConfig {
  folder?: string;
  format?: string;
  template?: string;
  autorun?: boolean;
}

// --- Input Schema ---
const schema = z
  .object({
    vault: z
      .string()
      .min(1, "Vault name cannot be empty")
      .describe("Name of the vault to get the daily note path for"),
    date: z
      .string()
      .optional()
      .describe(
        "Optional date for which to get the daily note path (ISO 8601 or YYYY-MM-DD). Defaults to today.",
      ),
  })
  .strict();

type GetDailyNotePathInput = z.infer<typeof schema>;

// --- Simple Date Formatter ---
function formatSimpleDate(date: Date, formatString: string): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const day = date.getDate();
  const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday

  // Add day names array
  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const fullDayName = dayNames[dayOfWeek];

  let formatted = formatString;
  formatted = formatted.replace(/YYYY/g, String(year));
  formatted = formatted.replace(/MM/g, String(month).padStart(2, "0"));
  formatted = formatted.replace(/M/g, String(month));
  formatted = formatted.replace(/DD/g, String(day).padStart(2, "0"));
  formatted = formatted.replace(/D/g, String(day));
  // Add replacement for dddd
  formatted = formatted.replace(/dddd/g, fullDayName);

  if (formatString.includes("W")) {
    const tempDate = new Date(date.valueOf());
    tempDate.setDate(tempDate.getDate() + 3 - ((tempDate.getDay() + 6) % 7));
    const week1 = new Date(tempDate.getFullYear(), 0, 4);
    const weekNumber =
      1 +
      Math.round(
        ((tempDate.getTime() - week1.getTime()) / 86400000 -
          3 +
          ((week1.getDay() + 6) % 7)) /
          7,
      );
    formatted = formatted.replace(/WW/g, String(weekNumber).padStart(2, "0"));
    formatted = formatted.replace(/W/g, String(weekNumber));
  }

  return formatted;
}

// --- Core Logic ---
async function getDailyNotePath(
  args: GetDailyNotePathInput,
  vaultPath: string,
): Promise<string> {
  // Read daily notes configuration
  const configFilePath = path.join(vaultPath, ".obsidian", "daily-notes.json");
  let config: DailyNotesConfig;

  try {
    const content = await fs.readFile(configFilePath, "utf8");
    config = JSON.parse(content) as DailyNotesConfig;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Daily Notes configuration file (daily-notes.json) not found in .obsidian folder. Is the plugin enabled and configured?",
      );
    }
    if (error instanceof SyntaxError) {
      throw new McpError(
        ErrorCode.InternalError,
        `Error parsing daily-notes.json: ${error.message}`,
      );
    }
    throw handleFsError(error, "read daily notes config");
  }

  if (!config.format) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Daily notes configuration is missing the 'format' field.",
    );
  }

  const folder = config.folder || "";

  // Determine which date to use
  let targetDate: Date;
  if (args.date) {
    // Parse all date inputs as local time for consistency with daily notes
    // Daily notes are typically about "today" in the user's local timezone
    if (/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
      // YYYY-MM-DD format
      const [year, month, day] = args.date.split("-").map(Number);
      targetDate = new Date(year, month - 1, day);
    } else if (/^\d{4}-\d{2}-\d{2}T/.test(args.date)) {
      // ISO format with time - extract just the date part for consistency
      const datePart = args.date.split("T")[0];
      const [year, month, day] = datePart.split("-").map(Number);
      targetDate = new Date(year, month - 1, day);
    } else {
      // Try to parse as-is for other formats
      targetDate = new Date(args.date);
    }

    if (isNaN(targetDate.getTime())) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid date format: '${args.date}'. Use YYYY-MM-DD or ISO 8601 format.`,
      );
    }
  } else {
    targetDate = new Date();
  }

  let formattedDate: string;
  try {
    formattedDate = formatSimpleDate(targetDate, config.format);
  } catch (formatError) {
    if (formatError instanceof McpError) throw formatError;
    throw new McpError(
      ErrorCode.InvalidParams,
      `Failed to format date using format string "${config.format}": ${(formatError as Error).message}`,
    );
  }

  // Construct the final path
  const finalPath = folder ? path.join(folder, formattedDate) : formattedDate;

  // Ensure the file has a markdown extension and return the path directly
  return ensureMarkdownExtension(finalPath);
}

// --- Tool Factory ---
export function createGetDailyNotePathTool(vaults: Map<string, string>) {
  return createTool<GetDailyNotePathInput>(
    {
      name: "get-daily-note-path",
      description: `Calculates the expected relative path for a daily note based on the Daily Notes core plugin settings (.obsidian/daily-notes.json).

You can specify a date (ISO 8601 or YYYY-MM-DD) to get the path for that day, or omit it to get today's path.
All dates are treated as local time for consistency with daily note usage.

Examples:
- Get today's path: { "vault": "my_vault" }
- Get path for a specific date: { "vault": "my_vault", "date": "2024-06-01" }
- ISO format: { "vault": "my_vault", "date": "2024-06-01T10:00:00Z" } (time ignored, date used as local)`,
      schema,
      handler: async (args, vaultPath, vaultName) => {
        try {
          const path = await getDailyNotePath(args, vaultPath);
          return {
            success: true,
            path: path,
            message: `Successfully determined daily note path: ${path}`,
          };
        } catch (error: any) {
          if (error instanceof McpError) {
            throw error;
          } else {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            throw new McpError(
              ErrorCode.InternalError,
              `Unexpected error in get-daily-note-path for vault '${args.vault}': ${errorMessage}`,
            );
          }
        }
      },
    },
    vaults,
  );
}
