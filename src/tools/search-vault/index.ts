import { z } from "zod";
import {
  SearchResult,
  SearchOperationResult,
  SearchOptions,
} from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  validateVaultPath,
  safeJoinPath,
  normalizePath,
} from "../../utils/path.js";
import { getAllMarkdownFiles } from "../../utils/files.js";
import { handleFsError } from "../../utils/errors.js";
import {
  extractTags,
  normalizeTag,
  matchesTagPattern,
} from "../../utils/tags.js";
import {
  createToolResponse,
  formatSearchResult,
} from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// --- Query Parsing Logic ---
interface ParsedQuery {
  cleanQuery: string;
  searchPath?: string;
  searchFile?: string;
}

function parseSearchQuery(rawQuery: string): ParsedQuery {
  const parts = rawQuery.split(/\s+/);
  const operators: { path?: string; file?: string } = {};
  const queryTerms: string[] = [];

  for (const part of parts) {
    if (part.startsWith("path:")) {
      operators.path = part.substring(5).replace(/^["']|["']$/g, ""); // Remove potential quotes
    } else if (part.startsWith("file:")) {
      operators.file = part.substring(5).replace(/^["']|["']$/g, ""); // Remove potential quotes
    } else {
      queryTerms.push(part);
    }
  }

  return {
    cleanQuery: queryTerms.join(" "),
    searchPath: operators.path,
    searchFile: operators.file,
  };
}
// --- End Query Parsing Logic ---

// Input validation schema with descriptions
const schema = z
  .object({
    vault: z
      .string()
      .min(1, "Vault name cannot be empty")
      .describe("Name of the vault to search in"),
    query: z
      .string()
      .min(1, "Search query cannot be empty")
      .describe(
        "Search query. Supports operators like path: and file: (e.g., 'term path:folder file:name'). For tag search use tag: prefix.",
      ),
    caseSensitive: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether to perform case-sensitive search (default: false)"),
    searchType: z
      .enum(["content", "filename", "both"])
      .optional()
      .default("content")
      .describe("Type of search to perform (default: content)"),
  })
  .strict();

type SearchVaultInput = z.infer<typeof schema>;

// Helper functions
function isTagSearch(query: string): boolean {
  return query.startsWith("tag:");
}

function normalizeTagQuery(query: string): string {
  // Remove 'tag:' prefix
  return normalizeTag(query.slice(4));
}

async function searchFilenames(
  vaultPath: string,
  query: string,
  options: SearchOptions,
  filePathPattern?: string,
): Promise<SearchResult[]> {
  try {
    // Use options.path which might be overridden by path: operator
    const searchDir = options.path
      ? safeJoinPath(vaultPath, options.path)
      : vaultPath;
    const files = await getAllMarkdownFiles(vaultPath, searchDir);
    const results: SearchResult[] = [];
    const searchQuery = options.caseSensitive ? query : query.toLowerCase();
    const filePatternLower =
      filePathPattern && !options.caseSensitive
        ? filePathPattern.toLowerCase()
        : filePathPattern;

    for (const file of files) {
      const relativePath = path.relative(vaultPath, file);
      const searchTarget = options.caseSensitive
        ? relativePath
        : relativePath.toLowerCase();

      // Check against file: pattern first if provided
      if (filePatternLower && !searchTarget.includes(filePatternLower)) {
        continue; // Skip if filename doesn't match file: pattern
      }

      // Check against main query if it exists or if searchType is filename/both
      if (
        options.searchType !== "content" &&
        (!searchQuery || searchTarget.includes(searchQuery))
      ) {
        results.push({
          file: relativePath,
          matches: [
            {
              line: 0,
              text: `Filename match: ${relativePath}`,
            },
          ],
        });
      }
    }

    return results;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw handleFsError(error, "search filenames");
  }
}

async function searchContent(
  vaultPath: string,
  query: string,
  options: SearchOptions,
  filePathPattern?: string,
): Promise<SearchResult[]> {
  try {
    const searchDir = options.path
      ? safeJoinPath(vaultPath, options.path)
      : vaultPath;
    const files = await getAllMarkdownFiles(vaultPath, searchDir);
    const results: SearchResult[] = [];
    const isTagQuery = isTagSearch(query);
    const normalizedTagQuery = isTagQuery ? normalizeTagQuery(query) : "";
    const searchQuery = options.caseSensitive ? query : query.toLowerCase();
    const filePatternLower =
      filePathPattern && !options.caseSensitive
        ? filePathPattern.toLowerCase()
        : filePathPattern;

    for (const file of files) {
      const relativePath = path.relative(vaultPath, file);
      const searchTargetFile = options.caseSensitive
        ? relativePath
        : relativePath.toLowerCase();

      // Check against file: pattern first if provided
      if (filePatternLower && !searchTargetFile.includes(filePatternLower)) {
        continue; // Skip if filename doesn't match file: pattern
      }

      // Skip content search if query is empty and it's not a tag search
      if (!query && !isTagQuery) continue;

      try {
        const content = await fs.readFile(file, "utf-8");
        const lines = content.split("\n");
        const matches: SearchResult["matches"] = [];

        if (isTagQuery) {
          // For tag searches, extract all tags from the content
          const fileTags = extractTags(content);

          lines.forEach((line, index) => {
            // Look for tag matches in each line
            const lineTags = extractTags(line);
            const hasMatchingTag = lineTags.some((tag) => {
              const normalizedTag = normalizeTag(tag);
              return (
                normalizedTag === normalizedTagQuery ||
                matchesTagPattern(normalizedTagQuery, normalizedTag)
              );
            });

            if (hasMatchingTag) {
              matches.push({
                line: index + 1,
                text: line.trim(),
              });
            }
          });
        } else {
          // Regular text search
          lines.forEach((line, index) => {
            const searchLine = options.caseSensitive
              ? line
              : line.toLowerCase();
            if (searchLine.includes(searchQuery)) {
              matches.push({
                line: index + 1,
                text: line.trim(),
              });
            }
          });
        }

        if (matches.length > 0) {
          results.push({
            file: relativePath,
            matches,
          });
        }
      } catch (err) {
        console.error(`Error reading file ${file}:`, err);
      }
    }

    return results;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw handleFsError(error, "search content");
  }
}

async function searchVault(
  vaultPath: string,
  rawQuery: string,
  options: SearchOptions,
): Promise<SearchOperationResult> {
  try {
    // Parse the query for operators
    const { cleanQuery, searchPath, searchFile } = parseSearchQuery(rawQuery);

    // Update options.path if path: operator was used
    const effectivePath = searchPath || options.path;
    const currentOptions: SearchOptions = { ...options, path: effectivePath };

    // Normalize vault path upfront
    const normalizedVaultPath = normalizePath(vaultPath);
    let results: SearchResult[] = [];
    let errors: string[] = [];

    // Determine effective search types based on operators and cleanQuery
    let runFilenameSearch =
      currentOptions.searchType === "filename" ||
      currentOptions.searchType === "both" ||
      !!searchFile;
    let runContentSearch =
      (currentOptions.searchType === "content" ||
        currentOptions.searchType === "both") &&
      (!!cleanQuery || isTagSearch(cleanQuery));

    // If only file: operator is present, search filenames
    if (
      searchFile &&
      !cleanQuery &&
      !isTagSearch(cleanQuery) &&
      currentOptions.searchType !== "content"
    ) {
      runFilenameSearch = true;
      runContentSearch = false;
    }
    // If only path: operator is present, search both content and filename by default?
    // Let's stick to the provided searchType or default ('content') unless overridden
    if (!searchFile && !cleanQuery && !isTagSearch(cleanQuery) && searchPath) {
      // If only path: is given, maybe default to both?
      // Or respect original searchType option. Let's respect option for now.
      // runFilenameSearch = currentOptions.searchType === 'filename' || currentOptions.searchType === 'both';
      // runContentSearch = currentOptions.searchType === 'content' || currentOptions.searchType === 'both';
    }

    // --- Perform Searches ---

    if (runFilenameSearch) {
      try {
        // Pass cleanQuery for text matching and searchFile for filtering
        const filenameResults = await searchFilenames(
          normalizedVaultPath,
          cleanQuery,
          currentOptions,
          searchFile,
        );
        // Merge results carefully - avoid duplicates if both content/filename search run
        filenameResults.forEach((fr) => {
          if (!results.some((r) => r.file === fr.file)) {
            results.push(fr);
          }
        });
      } catch (error) {
        if (error instanceof McpError) {
          errors.push(`Filename search error: ${error.message}`);
        } else {
          errors.push(
            `Filename search failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    if (runContentSearch) {
      try {
        // Pass cleanQuery for content matching and searchFile for filtering
        const contentResults = await searchContent(
          normalizedVaultPath,
          cleanQuery,
          currentOptions,
          searchFile,
        );
        // Merge results, potentially adding matches to existing file entries from filename search
        contentResults.forEach((cr) => {
          const existing = results.find((r) => r.file === cr.file);
          if (existing) {
            existing.matches = [
              ...(existing.matches || []),
              ...(cr.matches || []),
            ];
          } else {
            results.push(cr);
          }
        });
      } catch (error) {
        if (error instanceof McpError) {
          errors.push(`Content search error: ${error.message}`);
        } else {
          errors.push(
            `Content search failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Recalculate total matches after potential merging
    const totalMatches = results.reduce(
      (sum, result) => sum + (result.matches?.length ?? 0),
      0,
    );

    // If we have some results but also errors, we'll return partial results with a warning
    if (results.length > 0 && errors.length > 0) {
      return {
        success: true,
        message: `Search completed with warnings:\n${errors.join("\n")}`,
        results,
        totalMatches,
        matchedFiles: results.length,
      };
    }

    // If we have no results and errors, throw an error
    if (results.length === 0 && errors.length > 0) {
      throw new McpError(
        ErrorCode.InternalError,
        `Search failed:\n${errors.join("\n")}`,
      );
    }

    return {
      success: true,
      message: "Search completed successfully",
      results,
      totalMatches,
      matchedFiles: results.length,
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, "search vault");
  }
}

export const createSearchVaultTool = (vaults: Map<string, string>) => {
  return createTool<SearchVaultInput>(
    {
      name: "search-vault",
      description: `Search for specific content or filenames within vault notes.
Supports operators like 'path:' to limit search to a folder and 'file:' to limit by filename pattern.
Examples:
- Text search: { "query": "hello world" }
- Tag search: { "query": "tag:status/active" }
- Path scope: { "query": "term path:project/notes" }
- Filename scope: { "query": "term file:meeting" }
- Combined: { "query": "report path:projects file:Q3" }
Note: Use 'list-vaults' prompt to see available vaults.`,
      schema,
      handler: async (args, vaultPath, _vaultName) => {
        const options: SearchOptions = {
          caseSensitive: args.caseSensitive,
          searchType: args.searchType,
        };
        const result = await searchVault(vaultPath, args.query, options);
        return createToolResponse(formatSearchResult(result));
      },
    },
    vaults,
  );
};
