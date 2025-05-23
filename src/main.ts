#!/usr/bin/env node
import { ObsidianServer } from "./server.js";
import { createCreateNoteTool } from "./tools/create-note/index.js";
import { createListAvailableVaultsTool } from "./tools/list-available-vaults/index.js";
import { createEditNoteTool } from "./tools/edit-note/index.js";
import { createSearchVaultTool } from "./tools/search-vault/index.js";
import { createMoveNoteTool } from "./tools/move-note/index.js";
import { createCreateDirectoryTool } from "./tools/create-directory/index.js";
import { createDeleteNoteTool } from "./tools/delete-note/index.js";
import { createAddTagsTool } from "./tools/add-tags/index.js";
import { createRemoveTagsTool } from "./tools/remove-tags/index.js";
import { createReadNoteTool } from "./tools/read-note/index.js";
import { createListFilesTool } from "./tools/list-files/index.js";
import { createListDirectoryTool } from "./tools/list-directory/index.js";
import { createGetDailyNotePathTool } from "./tools/get-daily-note-path/index.js";
import { createGetTasksInNoteTool } from "./tools/get-tasks-in-note/index.js";
import { createToggleTaskTool } from "./tools/toggle-task/index.js";
import { listVaultsPrompt } from "./prompts/list-vaults/index.js";
import { registerPrompt } from "./utils/prompt-factory.js";
import path from "path";
import os from "os";
import { promises as fs, constants as fsConstants } from "fs";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  checkPathCharacters,
  checkLocalPath,
  checkSuspiciousPath,
  sanitizeVaultName,
  checkPathOverlap,
} from "./utils/path.js";

interface VaultConfig {
  name: string;
  path: string;
}

// Helper function to parse --vault arguments
function parseVaultArgs(args: string[]): VaultConfig[] {
  const vaultConfigs: VaultConfig[] = [];
  const seenNames: Set<string> = new Set();
  const seenPaths: Set<string> = new Set();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vault" && i + 1 < args.length) {
      const vaultArg = args[i + 1];
      const separatorIndex = vaultArg.indexOf(":");

      if (
        separatorIndex === -1 ||
        separatorIndex === 0 ||
        separatorIndex === vaultArg.length - 1
      ) {
        throw new Error(
          `Invalid --vault format: "${vaultArg}". Expected "name:/path/to/vault".`,
        );
      }

      const name = vaultArg.substring(0, separatorIndex);
      const rawPath = vaultArg.substring(separatorIndex + 1);

      const sanitizedName = sanitizeVaultName(name);
      if (!sanitizedName) {
        throw new Error(
          `Invalid vault name "${name}". Names must be alphanumeric (a-z, A-Z, 0-9), hyphen (-), or underscore (_) and start/end with alphanumeric.`,
        );
      }
      if (sanitizedName !== name) {
        console.warn(`Vault name "${name}" sanitized to "${sanitizedName}"`);
      }

      if (seenNames.has(sanitizedName)) {
        throw new Error(`Duplicate vault name "${sanitizedName}" provided.`);
      }
      seenNames.add(sanitizedName);

      // Basic path check before full validation
      if (!rawPath || rawPath.trim() === "") {
        throw new Error(
          `Empty path provided for vault name "${sanitizedName}".`,
        );
      }
      if (checkPathCharacters(rawPath)) {
        throw new Error(
          `Vault path for "${sanitizedName}" contains invalid characters: ${rawPath}`,
        );
      }

      // Add for now, full path validation happens later
      vaultConfigs.push({ name: sanitizedName, path: rawPath });
      i++; // Skip the value part
    } else if (args[i].startsWith("--")) {
      // Optional: Handle other potential future arguments or warn about unknown ones
      console.warn(`Ignoring unknown argument: ${args[i]}`);
      // If the unknown arg might have a value, skip it too: if (i + 1 < args.length && !args[i+1].startsWith('--')) i++;
    } else {
      // Optional: Handle positional arguments or warn
      console.warn(`Ignoring unexpected positional argument: ${args[i]}`);
    }
  }

  if (vaultConfigs.length === 0) {
    throw new Error(
      "No vaults provided. Use --vault name:/path/to/vault argument to specify at least one vault.",
    );
  }

  return vaultConfigs;
}

async function main() {
  // Constants
  const MAX_VAULTS = 10; // Reasonable limit to prevent resource issues

  let vaultConfigs: VaultConfig[] = [];
  const providedVaults: { name: string; path: string }[] = []; // Store initially parsed vaults for validation

  try {
    const args = process.argv.slice(2);
    providedVaults.push(...parseVaultArgs(args)); // Parse --vault arguments

    if (providedVaults.length === 0) {
      throw new Error(
        "Configuration error: No vaults were successfully parsed from arguments.",
      ); // Should be caught by parseVaultArgs, but safety check
    }

    if (providedVaults.length > MAX_VAULTS) {
      throw new Error(
        `Too many vaults specified (${providedVaults.length}). Maximum allowed is ${MAX_VAULTS}.`,
      );
    }

    console.error(
      `Received ${providedVaults.length} vault configuration(s) from command line. Validating...`,
    );

    // Validate and normalize vault paths concurrently
    const validatedConfigs = await Promise.all(
      providedVaults.map(async ({ name, path: rawPath }) => {
        try {
          // Expand home directory if needed
          const expandedPath = rawPath.startsWith("~")
            ? path.join(os.homedir(), rawPath.slice(1))
            : rawPath;

          // Normalize and convert to absolute path
          const normalizedPath = path
            .normalize(expandedPath)
            .replace(/[\\\\/\\\\\\\\]+$/, ""); // Remove trailing slashes
          const absolutePath = path.resolve(normalizedPath);

          // Validate path is absolute
          if (!path.isAbsolute(absolutePath)) {
            throw new Error(`Vault path must be absolute: ${rawPath}`);
          }

          // Check for suspicious paths and local filesystem
          const [suspiciousReason, localPathIssue] = await Promise.all([
            checkSuspiciousPath(absolutePath),
            checkLocalPath(absolutePath),
          ]);

          if (localPathIssue) {
            throw new Error(
              `Invalid vault path (${localPathIssue}): ${rawPath}\\n` +
                `For reliability and security reasons, vault paths must:\\n` +
                `- Be on a local filesystem\\n` +
                `- Not use network drives or mounts\\n` +
                `- Not contain symlinks that point outside their directory`,
            );
          }

          if (suspiciousReason) {
            throw new Error(
              `Invalid vault path (${suspiciousReason}): ${rawPath}\\n` +
                `For security reasons, vault paths cannot:\\n` +
                `- Point to system directories\\n` +
                `- Use hidden directories (except .obsidian)\\n` +
                `- Point to the home directory root\\n` +
                `Please choose a dedicated directory for your vault`,
            );
          }

          // Check if path exists and is a directory
          const stats = await fs.stat(absolutePath);
          if (!stats.isDirectory()) {
            throw new Error(`Vault path must be a directory: ${rawPath}`);
          }

          // Check if path is readable and writable
          await fs.access(absolutePath, fsConstants.R_OK | fsConstants.W_OK);

          // Check if this is a valid Obsidian vault
          const obsidianConfigPath = path.join(absolutePath, ".obsidian");
          const obsidianAppConfigPath = path.join(
            obsidianConfigPath,
            "app.json",
          );

          try {
            // Check .obsidian directory
            const configStats = await fs.stat(obsidianConfigPath);
            if (!configStats.isDirectory()) {
              throw new Error(
                `Invalid Obsidian vault configuration in ${rawPath}\\n` +
                  `The .obsidian folder exists but is not a directory\\n` +
                  `Try removing it and reopening the vault in Obsidian`,
              );
            }

            // Check app.json to verify it's properly initialized
            await fs.access(obsidianAppConfigPath, fsConstants.R_OK);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              throw new Error(
                `Not a valid Obsidian vault (${rawPath})\\n` +
                  `Vault requires a valid .obsidian directory with configuration (e.g., app.json)\\n` +
                  `Please open this path in Obsidian first to initialize it.`,
              );
            }
            // Re-throw other stat/access errors or validation errors from above
            throw error;
          }

          // If all checks pass, return the validated config
          return { name, path: absolutePath };
        } catch (validationError: any) {
          // Add vault name context to the error
          throw new Error(
            `Validation failed for vault "${name}" (${rawPath}): ${validationError.message}`,
          );
        }
      }),
    );

    // Check for overlapping paths *after* normalization
    try {
      checkPathOverlap(validatedConfigs.map((vc) => vc.path));
    } catch (overlapError: any) {
      throw new Error(`Vault path overlap detected: ${overlapError.message}`);
    }

    // Assign validated configs
    vaultConfigs = validatedConfigs;

    console.error("Vault validation successful:");
    vaultConfigs.forEach((vc) =>
      console.error(`- Name: '${vc.name}', Path: '${vc.path}'`),
    );
  } catch (error: any) {
    // Catch errors from parsing or validation
    console.error(`Error during initialization: ${error.message}`);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: ErrorCode.InvalidParams, // Use InvalidParams for config issues
          message: `Server configuration error: ${error.message}`,
        },
        id: null,
      }),
    );
    process.exit(1);
  }

  // --- SERVER INITIALIZATION ---
  if (vaultConfigs.length === 0) {
    // This should technically not be reachable if the default logic works,
    // but added as a safeguard.
    console.error(
      "Critical Error: No vault configurations available after processing. Cannot start server.",
    );
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: ErrorCode.InternalError,
          message: "Server failed to initialize vault configurations.",
        },
        id: null,
      }),
    );
    process.exit(1);
  }

  let server: ObsidianServer;
  try {
    // Initialize the server with the validated vault configurations
    server = new ObsidianServer(vaultConfigs);

    // Create map for tool factories AFTER server initialization
    const vaultsMap = new Map<string, string>();
    vaultConfigs.forEach((vc) => vaultsMap.set(vc.name, vc.path));

    // Register tools (pass vaultsMap to tool factories)
    server.registerTool(createCreateNoteTool(vaultsMap));
    // Conditionally register ListAvailableVaultsTool only if multiple vaults configured
    if (vaultsMap.size > 1) {
      server.registerTool(createListAvailableVaultsTool(vaultsMap));
    }
    server.registerTool(createEditNoteTool(vaultsMap));
    server.registerTool(createSearchVaultTool(vaultsMap));
    server.registerTool(createMoveNoteTool(vaultsMap));
    server.registerTool(createCreateDirectoryTool(vaultsMap));
    server.registerTool(createDeleteNoteTool(vaultsMap));
    server.registerTool(createAddTagsTool(vaultsMap));
    server.registerTool(createRemoveTagsTool(vaultsMap));
    server.registerTool(createReadNoteTool(vaultsMap));
    server.registerTool(createListFilesTool(vaultsMap));
    server.registerTool(createListDirectoryTool(vaultsMap));
    server.registerTool(createGetDailyNotePathTool(vaultsMap));
    server.registerTool(createGetTasksInNoteTool(vaultsMap));
    server.registerTool(createToggleTaskTool(vaultsMap));

    // Register prompts (Handled by server constructor now)
    // registerPrompt(listVaultsPrompt); // REMOVED redundant call
  } catch (error: any) {
    // Catch errors during server or tool registration
    console.error(
      `Failed during server initialization or tool registration: ${error.message}`,
    );
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: ErrorCode.InternalError,
          message: `Server initialization failed: ${error.message}`,
        },
        id: null,
      }),
    );
    process.exit(1);
  }

  // Graceful shutdown handler
  let isShuttingDown = false;
  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.error(`Received ${signal}. Shutting down server...`);
    try {
      await server.stop();
      console.error("Server stopped gracefully.");
      process.exit(0);
    } catch (error) {
      console.error("Error during server shutdown:", error);
      process.exit(1);
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGQUIT", () => shutdown("SIGQUIT")); // Often used for graceful shutdown

  // Handle unhandled exceptions
  process.on("uncaughtException", (error) => {
    console.error("CRITICAL: Uncaught Exception:", error);
    // Attempt graceful shutdown, but exit quickly if it fails
    shutdown("uncaughtException").catch(() => process.exit(1));
    setTimeout(() => process.exit(1), 2000); // Force exit after 2s if shutdown hangs
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error(
      "CRITICAL: Unhandled Rejection at:",
      promise,
      "reason:",
      reason,
    );
    // Optionally attempt shutdown
    // shutdown('unhandledRejection').catch(() => process.exit(1));
    // setTimeout(() => process.exit(1), 2000);
  });

  try {
    await server.start();
    console.error("Obsidian MCP Server started successfully.");
  } catch (error: any) {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error in main function:", error);
  process.exit(1);
});
