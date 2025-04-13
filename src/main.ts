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
import { createRenameTagTool } from "./tools/rename-tag/index.js";
import { createReadNoteTool } from "./tools/read-note/index.js";
import { createAddAliasTool } from "./tools/add-alias/index.js";
import { createRemoveAliasTool } from "./tools/remove-alias/index.js";
import { createListAliasesTool } from "./tools/list-aliases/index.js";
import { createListFilesTool } from "./tools/list-files/index.js";
import { createListDirectoryTool } from "./tools/list-directory/index.js";
import { createGetBacklinksTool } from "./tools/get-backlinks/index.js";
import { createListBookmarksTool } from "./tools/list-bookmarks/index.js";
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
  checkPathOverlap 
} from "./utils/path.js";

interface VaultConfig {
  name: string;
  path: string;
}

async function main() {
  // Constants
  const MAX_VAULTS = 10; // Reasonable limit to prevent resource issues

  const vaultArgs = process.argv.slice(2);
  let vaultConfigs: VaultConfig[] = [];

  if (vaultArgs.length === 0) {
    // --- NO ARGUMENTS PROVIDED ---
    // Use a default configuration. The client is expected to provide vault context via tool args.
    console.error("No vault paths provided via command line. Using default configuration.");
    console.error("Server expects vault context ('vault' name) in tool arguments.");

    // Define your default vault(s) here
    const defaultVaultPath = "/home/justin/Documents/Work/Vault/Minerva"; // User's Minerva path
    const defaultVaultName = "minerva"; // Logical name for the client to use

    try {
      // Basic validation for the default path
      const obsidianConfigPath = path.join(defaultVaultPath, '.obsidian');
      const stats = await fs.stat(obsidianConfigPath);
      if (!stats.isDirectory()) {
        throw new Error(".obsidian exists but is not a directory.");
      }
      vaultConfigs = [{ name: defaultVaultName, path: path.resolve(defaultVaultPath) }];
      console.error(`Default vault configured: name='${defaultVaultName}', path='${vaultConfigs[0].path}'`);

    } catch (error: any) {
      console.error(`Error validating default vault path '${defaultVaultPath}': ${error.message}`);
      console.error("Please ensure the default vault path is correct and the vault is initialized in Obsidian.");
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: ErrorCode.InvalidRequest,
          message: `Failed to initialize with default vault '${defaultVaultPath}': ${error.message}`
        },
        id: null
      }));
      process.exit(1);
    }

  } else {
    // --- ARGUMENTS PROVIDED ---
    // Use existing logic to parse and validate arguments
    console.error(`Received ${vaultArgs.length} vault path(s) from command line. Validating...`);

    if (vaultArgs.length > MAX_VAULTS) {
      const errorMessage = `Too many vault paths provided. Maximum allowed is ${MAX_VAULTS}.`;
      console.error(`Error: ${errorMessage}`);
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: ErrorCode.InvalidRequest, message: errorMessage },
        id: null
      }));
      process.exit(1);
    }


    // Validate and normalize vault paths
    const normalizedPaths = await Promise.all(vaultArgs.map(async (vaultPath, index) => {
      try {
        // Expand home directory if needed
        const expandedPath = vaultPath.startsWith('~') ?
          path.join(os.homedir(), vaultPath.slice(1)) :
          vaultPath;

        // Normalize and convert to absolute path
        const normalizedPath = path.normalize(expandedPath)
          .replace(/[\\/\\\\]+$/, ''); // Remove trailing slashes
        const absolutePath = path.resolve(normalizedPath);

        // Validate path is absolute and safe
        if (!path.isAbsolute(absolutePath)) {
          const errorMessage = `Vault path must be absolute: ${vaultPath}`;
          console.error(`Error: ${errorMessage}`);

          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: ErrorCode.InvalidRequest,
              message: errorMessage
            },
            id: null
          }));

          process.exit(1);
        }

        // Check for suspicious paths and local filesystem
        const [suspiciousReason, localPathIssue] = await Promise.all([
          checkSuspiciousPath(absolutePath),
          checkLocalPath(absolutePath)
        ]);

        if (localPathIssue) {
          const errorMessage = `Invalid vault path (${localPathIssue}): ${vaultPath}\\n` +
            `For reliability and security reasons, vault paths must:\\n` +
            `- Be on a local filesystem\\n` +
            `- Not use network drives or mounts\\n` +
            `- Not contain symlinks that point outside their directory`;

          console.error(`Error: ${errorMessage}`);

          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: ErrorCode.InvalidRequest,
              message: errorMessage
            },
            id: null
          }));

          process.exit(1);
        }

        if (suspiciousReason) {
          const errorMessage = `Invalid vault path (${suspiciousReason}): ${vaultPath}\\n` +
            `For security reasons, vault paths cannot:\\n` +
            `- Point to system directories\\n` +
            `- Use hidden directories (except .obsidian)\\n` +
            `- Point to the home directory root\\n` +
            `Please choose a dedicated directory for your vault`;

          console.error(`Error: ${errorMessage}`);

          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: ErrorCode.InvalidRequest,
              message: errorMessage
            },
            id: null
          }));

          process.exit(1);
        }

        try {
          // Check if path exists and is a directory
          const stats = await fs.stat(absolutePath);
          if (!stats.isDirectory()) {
            const errorMessage = `Vault path must be a directory: ${vaultPath}`;
            console.error(`Error: ${errorMessage}`);

            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: ErrorCode.InvalidRequest,
                message: errorMessage
              },
              id: null
            }));

            process.exit(1);
          }

          // Check if path is readable and writable
          await fs.access(absolutePath, fsConstants.R_OK | fsConstants.W_OK);

          // Check if this is a valid Obsidian vault
          const obsidianConfigPath = path.join(absolutePath, '.obsidian');
          const obsidianAppConfigPath = path.join(obsidianConfigPath, 'app.json');

          try {
            // Check .obsidian directory
            const configStats = await fs.stat(obsidianConfigPath);
            if (!configStats.isDirectory()) {
              const errorMessage = `Invalid Obsidian vault configuration in ${vaultPath}\\n` +
                `The .obsidian folder exists but is not a directory\\n` +
                `Try removing it and reopening the vault in Obsidian`;

              console.error(`Error: ${errorMessage}`);

              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: ErrorCode.InvalidRequest,
                  message: errorMessage
                },
                id: null
              }));

              process.exit(1);
            }

            // Check app.json to verify it's properly initialized
            await fs.access(obsidianAppConfigPath, fsConstants.R_OK);

          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              const errorMessage = `Not a valid Obsidian vault (${vaultPath})\\n` +
                `Vault requires a valid .obsidian directory with configuration (e.g., app.json)\\n` +
                `Please open this path in Obsidian first to initialize it.`;

              console.error(`Error: ${errorMessage}`);

              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: ErrorCode.InvalidRequest,
                  message: errorMessage
                },
                id: null
              }));

              process.exit(1);
            }
            throw error; // Re-throw other stat/access errors
          }

          return absolutePath;

        } catch (error: any) {
          const errorMessage = `Error accessing vault path ${vaultPath}: ${error.message}`;
          console.error(`Error: ${errorMessage}`);
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: ErrorCode.InvalidRequest,
              message: errorMessage
            },
            id: null
          }));
          process.exit(1);
        }
      } catch (error) {
        // Handle any unexpected errors during path processing
        const errorMessage = `Unexpected error processing vault path ${vaultPath}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`Error: ${errorMessage}`);
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: ErrorCode.InternalError, message: errorMessage },
          id: null
        }));
        process.exit(1);
      }
    }));


    // Check for duplicate paths
    const uniquePaths = new Set(normalizedPaths);
    if (uniquePaths.size !== normalizedPaths.length) {
      const errorMessage = "Duplicate vault paths provided. Each path must be unique.";
      console.error(`Error: ${errorMessage}`);
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: ErrorCode.InvalidRequest, message: errorMessage },
        id: null
      }));
      process.exit(1);
    }

    // Check for overlapping paths
    try {
      checkPathOverlap(normalizedPaths);
    } catch (error) {
        const errorMessage = error instanceof McpError ? error.message : String(error);
        console.error(`Error: ${errorMessage}`);
        process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: ErrorCode.InvalidRequest, message: errorMessage },
            id: null
        }));
        process.exit(1);
    }

    // Generate vault names and construct VaultConfig objects
    const vaultNames: { [name: string]: number } = {};
    vaultConfigs = normalizedPaths.map(absPath => {
      const baseName = sanitizeVaultName(path.basename(absPath));
      let name = baseName;
      let count = 1;
      while (vaultNames[name]) {
        count++;
        name = `${baseName}-${count}`;
      }
      vaultNames[name] = 1;
      return { name, path: absPath };
    });
    console.error("Validated vault configurations:", vaultConfigs);
  } // End of argument processing logic


  // --- SERVER INITIALIZATION ---
  if (vaultConfigs.length === 0) {
      // This should technically not be reachable if the default logic works,
      // but added as a safeguard.
      console.error("Critical Error: No vault configurations available after processing. Cannot start server.");
       process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: ErrorCode.InternalError,
          message: "Server failed to initialize vault configurations."
        },
        id: null
      }));
      process.exit(1);
  }

  let server: ObsidianServer;
  try {
    server = new ObsidianServer(vaultConfigs);
  } catch (error: any) {
     console.error(`Failed to initialize ObsidianServer: ${error.message}`);
     process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: ErrorCode.InternalError,
          message: `Server initialization failed: ${error.message}`
        },
        id: null
      }));
     process.exit(1);
  }


  // Create map for tool factories
  const vaultsMap = new Map(vaultConfigs.map(v => [v.name, v.path]));

  // Register tools
  server.registerTool(createReadNoteTool(vaultsMap));
  server.registerTool(createCreateNoteTool(vaultsMap));
  server.registerTool(createEditNoteTool(vaultsMap));
  server.registerTool(createMoveNoteTool(vaultsMap));
  server.registerTool(createDeleteNoteTool(vaultsMap));
  server.registerTool(createCreateDirectoryTool(vaultsMap));
  server.registerTool(createSearchVaultTool(vaultsMap));
  server.registerTool(createAddTagsTool(vaultsMap));
  server.registerTool(createRemoveTagsTool(vaultsMap));
  server.registerTool(createRenameTagTool(vaultsMap));
  server.registerTool(createAddAliasTool(vaultsMap));
  server.registerTool(createRemoveAliasTool(vaultsMap));
  server.registerTool(createListAliasesTool(vaultsMap));
  server.registerTool(createListFilesTool(vaultsMap));
  server.registerTool(createListDirectoryTool(vaultsMap));
  server.registerTool(createGetBacklinksTool(vaultsMap));
  server.registerTool(createListBookmarksTool(vaultsMap));

  // Conditionally register ListAvailableVaultsTool only if multiple vaults configured
  if (vaultConfigs.length > 1) {
      server.registerTool(createListAvailableVaultsTool(vaultsMap));
  }


  // Graceful shutdown handling
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

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGQUIT', () => shutdown('SIGQUIT')); // Often used for graceful shutdown

  // Handle unhandled exceptions
  process.on('uncaughtException', (error) => {
    console.error('CRITICAL: Uncaught Exception:', error);
    // Attempt graceful shutdown, but exit quickly if it fails
    shutdown('uncaughtException').catch(() => process.exit(1));
    setTimeout(() => process.exit(1), 2000); // Force exit after 2s if shutdown hangs
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
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

main().catch(error => {
  console.error("Unhandled error in main function:", error);
  process.exit(1);
});
