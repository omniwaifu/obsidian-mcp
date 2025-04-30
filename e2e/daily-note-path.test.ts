import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import path from "path";
import { promises as fs } from "fs";
import { ObsidianServer } from "../src/server"; // Import the server class
import { createGetDailyNotePathTool } from "../src/tools/get-daily-note-path"; // Import the tool factory
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"; // Keep SDK types for error checking if needed
import { z } from "zod"; // Import zod for error checking

describe("E2E: get-daily-note-path Tool (Internal Server Test)", () => {
  let testVaultPath: string;
  let server: ObsidianServer;
  let callToolHandler: (request: any) => Promise<any>; // Simulate the tool call handler

  // Setup: Create temp vault and config
  beforeAll(async () => {
    testVaultPath = path.join(import.meta.dir, "_test_vault_daily_path");
    const obsidianConfigPath = path.join(testVaultPath, ".obsidian");
    await fs.mkdir(obsidianConfigPath, { recursive: true });

    // Create daily-notes.json with a specific format
    const dailyNotesConfig = {
      folder: "Journal/Daily",
      format: "YYYY-MM-DD dddd", // Format for testing
      template: "",
      autorun: false,
    };
    await fs.writeFile(
      path.join(obsidianConfigPath, "daily-notes.json"),
      JSON.stringify(dailyNotesConfig),
    );

    // Create app.json to satisfy vault check
    await fs.writeFile(
      path.join(obsidianConfigPath, "app.json"),
      JSON.stringify({ dummy: "config" }),
    );

    // Instantiate the server directly
    const vaultConfigs = [{ name: "test_daily_vault", path: testVaultPath }];
    server = new ObsidianServer(vaultConfigs);

    // Register the tool
    const vaultsMap = new Map(vaultConfigs.map((v) => [v.name, v.path]));
    server.registerTool(createGetDailyNotePathTool(vaultsMap));

    // Simulate the CallTool handler logic from ObsidianServer
    callToolHandler = async (request: any) => {
      const params = request.params;
      const name = params.name;
      const args = params.arguments;
      const tool = server["tools"].get(name); // Access private 'tools' map

      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      try {
        const validatedArgs = tool.inputSchema.parse(args);
        // The tool.handler created by createTool takes only validatedArgs
        const result = await tool.handler(validatedArgs);
        // Return the raw result structure the server would wrap
        return result;
      } catch (error) {
        // console.error("E2E Test: Tool execution error:", error); // Keep commented out unless debugging test itself
        // Simulate proper error wrapping if needed, or just rethrow for test failure
        if (error instanceof McpError) throw error;
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid arguments: ${error.message}`,
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Unexpected test error: ${error}`,
        );
      }
    };
  });

  // Teardown: Remove temp vault
  afterAll(async () => {
    try {
      if (await fs.stat(testVaultPath).catch(() => null)) {
        await fs.rm(testVaultPath, { recursive: true, force: true });
      }
    } catch (error) {
      console.error(`Error cleaning up test vault ${testVaultPath}:`, error);
    }
  });

  it("should return the correct daily note path based on config", async () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const dayName = dayNames[today.getDay()];

    const expectedFilename = `${year}-${month}-${day} ${dayName}.md`;
    const expectedRelativePath = `Journal/Daily/${expectedFilename}`; // Based on config

    const request = {
      params: {
        name: "get-daily-note-path",
        arguments: { vault: "test_daily_vault" },
      },
    };

    try {
      const response = await callToolHandler(request);

      expect(response.content).toBeInstanceOf(Array);
      expect(response.content.length).toBe(1);
      expect(response.content[0].type).toBe("text");
      // Check the content of the text message returned by createToolResponse
      expect(response.content[0].text).toBe(
        `Daily note path: ${expectedRelativePath}`,
      );
    } catch (error) {
      console.error("Tool call failed:", error);
      expect(error).toBeNull(); // Fail test if error occurs
    }
  });

  it("should return error if vault name is invalid", async () => {
    const request = {
      params: {
        name: "get-daily-note-path",
        arguments: { vault: "non_existent_vault" },
      },
    };

    try {
      await callToolHandler(request);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      // The error now originates from VaultResolver within the createTool handler wrapper
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((error as McpError).message).toContain(
        "Unknown vault: non_existent_vault",
      );
    }
  });
});
