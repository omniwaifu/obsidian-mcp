import { promises as fs, Dirent } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { normalizePath, safeJoinPath, checkPathSafety } from "./path.js";

// Helper function to check if a path is likely hidden or system-related *relative to the vault*
function isHiddenOrSystem(fullPath: string, vaultPath: string): boolean {
  const relativePath = path.relative(vaultPath, fullPath);
  if (!relativePath || relativePath.startsWith("..")) {
    // If path is outside or same as vault, it's not hidden *within* the vault context
    return false;
  }
  // Check relative path components for dot-prefixed parts (excluding .obsidian)
  const parts = relativePath.split(/[/\\]/);
  return parts.some(
    (part) => part.length > 0 && part.startsWith(".") && part !== ".obsidian",
  );
}

/**
 * Recursively finds all markdown files in a directory, excluding hidden files/folders.
 * @param vaultPath - The absolute path to the vault root.
 * @param searchDir - Optional specific directory within the vault to search.
 * @returns A promise resolving to an array of absolute file paths.
 */
export async function getAllMarkdownFiles(
  vaultPath: string,
  dir = vaultPath,
): Promise<string[]> {
  // Normalize paths upfront
  const normalizedVaultPath = normalizePath(vaultPath);
  const normalizedDir = normalizePath(dir);

  // Verify directory is within vault
  if (!normalizedDir.startsWith(normalizedVaultPath)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Search directory must be within vault: ${dir}`,
    );
  }

  const files: string[] = [];
  let entries: Dirent[];

  try {
    entries = await fs.readdir(normalizedDir, { withFileTypes: true });
  } catch (error) {
    if ((error as any).code === "ENOENT") {
      // If the specific search directory doesn't exist, return empty (could be race condition)
      // If the vault path itself doesn't exist (dir === normalizedVaultPath), throw
      if (normalizedDir !== normalizedVaultPath) {
        console.warn(
          `Directory not found during markdown file scan (ignoring): ${normalizedDir}`,
        );
        return [];
      }
      // Re-throw if vaultPath itself doesn't exist
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Vault directory not found: ${normalizedVaultPath}`,
      );
    }
    // Rethrow other readdir errors
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read directory ${normalizedDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const entry of entries) {
    const fullPath = path.join(normalizedDir, entry.name);

    // Explicitly skip the .obsidian directory itself
    if (entry.isDirectory() && entry.name === ".obsidian") {
      continue;
    }

    // Pass vaultPath to isHiddenOrSystem
    const isHidden = isHiddenOrSystem(fullPath, normalizedVaultPath);
    // --- TEMP LOGGING REMOVED ---
    // console.log(`[getAllMarkdownFiles] Checking: ${fullPath}, Hidden: ${isHidden}`);
    // --- END TEMP LOGGING ---

    if (isHidden) {
      continue;
    }

    try {
      if (entry.isDirectory()) {
        // Recurse using the vaultPath as the base and the new fullPath
        const subDirFiles = await getAllMarkdownFiles(
          normalizedVaultPath,
          fullPath,
        );
        files.push(...subDirFiles);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        // Normalize the final file path before adding
        files.push(normalizePath(fullPath));
      }
    } catch (error) {
      // Log errors during processing of specific entries but continue the scan
      if (error instanceof McpError) {
        console.error(
          `Skipping ${entry.name} in ${normalizedDir}:`,
          error.message,
        );
      } else {
        console.error(
          `Error processing ${entry.name} in ${normalizedDir}:`,
          error,
        );
      }
      // Optionally: rethrow if you want scan to fail on any single error
      // throw error;
    }
  }

  return files;
}

/**
 * Recursively finds all non-markdown files in a directory, excluding hidden files/folders.
 * @param vaultPath - The absolute path to the vault root.
 * @param searchDir - Optional specific directory within the vault to search.
 * @returns A promise resolving to an array of absolute file paths.
 */
export async function getAllNonMarkdownFiles(
  vaultPath: string,
  searchDir?: string,
): Promise<string[]> {
  const normalizedVaultPath = normalizePath(vaultPath);
  const targetDir = searchDir ? normalizePath(searchDir) : normalizedVaultPath;

  if (!targetDir.startsWith(normalizedVaultPath)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Search directory must be inside the vault path",
    );
  }

  const files: string[] = [];
  let entries: Dirent[];

  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // If the specific search directory doesn't exist, return empty
      // If the vault path itself doesn't exist, throw
      if (targetDir !== normalizedVaultPath) {
        console.warn(
          `Directory not found during non-markdown file scan (ignoring): ${targetDir}`,
        );
        return [];
      }
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Vault directory not found: ${normalizedVaultPath}`,
      );
    }
    console.error(`Error reading directory ${targetDir}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read directory: ${targetDir}`,
    );
  }

  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);

    // Explicitly skip the .obsidian directory itself
    if (entry.isDirectory() && entry.name === ".obsidian") {
      continue;
    }

    // Pass vaultPath to isHiddenOrSystem
    if (isHiddenOrSystem(fullPath, normalizedVaultPath)) {
      continue;
    }

    try {
      if (entry.isDirectory()) {
        // Recurse using the vaultPath as the base and the new fullPath
        files.push(...(await getAllNonMarkdownFiles(vaultPath, fullPath)));
      } else if (entry.isFile() && !entry.name.toLowerCase().endsWith(".md")) {
        // Add file if it's not markdown (and not already excluded by isHiddenOrSystem)
        // Normalize the final file path before adding
        files.push(normalizePath(fullPath));
      }
    } catch (error) {
      // Log errors during processing of specific entries but continue the scan
      if (error instanceof McpError) {
        console.error(`Skipping ${entry.name} in ${targetDir}:`, error.message);
      } else {
        console.error(`Error processing ${entry.name} in ${targetDir}:`, error);
      }
      // Optionally: rethrow if you want scan to fail on any single error
      // throw error;
    }
  }
  return files;
}

/**
 * Ensures a directory exists, creating it if necessary
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  const normalizedPath = normalizePath(dirPath);

  try {
    await fs.mkdir(normalizedPath, { recursive: true });
  } catch (error: any) {
    if (error.code !== "EEXIST") {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create directory ${dirPath}: ${error.message}`,
      );
    }
  }
}

/**
 * Checks if a file exists at the given path.
 * @param filePath - The path to check.
 * @returns True if a file exists, false otherwise (including if it's a directory).
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath); // Use stat
    return stats.isFile(); // Check isFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false; // File doesn't exist
    }
    // Could be a directory or permissions error, etc. Treat as file not existing.
    return false;
  }
}

/**
 * Safely reads a file's contents
 * Returns undefined if file doesn't exist
 */
export async function safeReadFile(
  filePath: string,
): Promise<string | undefined> {
  try {
    // No normalization needed here if fileExists/callers normalize
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    if ((error as NodeJS.ErrnoException).code === "EISDIR") {
      console.warn(`Attempted to read a directory as a file: ${filePath}`);
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Path is a directory, not a file: ${filePath}`,
      );
    }
    console.error(`Error reading file ${filePath}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read file: ${filePath}`,
    );
  }
}
