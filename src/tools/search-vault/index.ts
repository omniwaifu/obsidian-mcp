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

// --- Unified Search Logic ---
interface SearchContext {
  vaultPath: string;
  normalizedVaultPath: string;
  options: SearchOptions;
  isTagQuery: boolean;
  normalizedTagQuery: string;
  searchQuery: string;
  filePattern?: string;
  shouldSearchFilenames: boolean;
  shouldSearchContent: boolean;
}

async function performUnifiedSearch(
  context: SearchContext,
): Promise<{ results: SearchResult[]; errors: string[] }> {
  const { vaultPath, normalizedVaultPath, options } = context;
  const results: SearchResult[] = [];
  const errors: string[] = [];

  try {
    // Get all files once
    const searchDir = options.path
      ? safeJoinPath(vaultPath, options.path)
      : vaultPath;
    const files = await getAllMarkdownFiles(vaultPath, searchDir);

    // Pre-calculate case-sensitive values once
    const filePatternLower =
      context.filePattern && !options.caseSensitive
        ? context.filePattern.toLowerCase()
        : context.filePattern;

    for (const file of files) {
      const relativePath = path.relative(vaultPath, file);
      const searchTargetFile = options.caseSensitive
        ? relativePath
        : relativePath.toLowerCase();

      // Filter by file pattern first if provided
      if (filePatternLower && !searchTargetFile.includes(filePatternLower)) {
        continue;
      }

      const fileMatches: SearchResult["matches"] = [];

      // Filename search
      if (context.shouldSearchFilenames) {
        if (
          !context.searchQuery ||
          searchTargetFile.includes(context.searchQuery)
        ) {
          fileMatches.push({
            line: 0,
            text: `Filename match: ${relativePath}`,
          });
        }
      }

      // Content search
      if (
        context.shouldSearchContent &&
        (context.searchQuery || context.isTagQuery)
      ) {
        try {
          const content = await fs.readFile(file, "utf-8");

          if (context.isTagQuery) {
            // Tag search - extract all tags from content
            const fileTags = extractTags(content);
            const lines = content.split("\n");

            lines.forEach((line, index) => {
              const lineTags = extractTags(line);
              const hasMatchingTag = lineTags.some((tag) => {
                const normalizedTag = normalizeTag(tag);
                return (
                  normalizedTag === context.normalizedTagQuery ||
                  matchesTagPattern(context.normalizedTagQuery, normalizedTag)
                );
              });

              if (hasMatchingTag) {
                fileMatches.push({
                  line: index + 1,
                  text: line.trim(),
                });
              }
            });
          } else if (context.searchQuery) {
            // Regular text search
            const lines = content.split("\n");
            lines.forEach((line, index) => {
              const searchLine = options.caseSensitive
                ? line
                : line.toLowerCase();
              if (searchLine.includes(context.searchQuery)) {
                fileMatches.push({
                  line: index + 1,
                  text: line.trim(),
                });
              }
            });
          }
        } catch (err) {
          errors.push(
            `Error reading file ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Add to results if we found matches
      if (fileMatches.length > 0) {
        results.push({
          file: relativePath,
          matches: fileMatches,
        });
      }
    }

    return { results, errors };
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw handleFsError(error, "unified search");
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

    // Determine search requirements
    const isTag = isTagSearch(cleanQuery);
    const hasQuery = !!cleanQuery;
    const hasFilePattern = !!searchFile;

    // Determine what to search based on searchType and query content
    let shouldSearchFilenames = false;
    let shouldSearchContent = false;

    switch (currentOptions.searchType) {
      case "filename":
        shouldSearchFilenames = true;
        break;
      case "content":
        shouldSearchContent = hasQuery || isTag;
        break;
      case "both":
        shouldSearchFilenames = true;
        shouldSearchContent = hasQuery || isTag;
        break;
    }

    // If only file: operator is present, force filename search
    if (hasFilePattern && !hasQuery && !isTag) {
      shouldSearchFilenames = true;
      shouldSearchContent = false;
    }

    // Create search context
    const searchContext: SearchContext = {
      vaultPath,
      normalizedVaultPath,
      options: currentOptions,
      isTagQuery: isTag,
      normalizedTagQuery: isTag ? normalizeTagQuery(cleanQuery) : "",
      searchQuery: currentOptions.caseSensitive
        ? cleanQuery
        : cleanQuery.toLowerCase(),
      filePattern: searchFile,
      shouldSearchFilenames,
      shouldSearchContent,
    };

    // Perform unified search
    const { results, errors } = await performUnifiedSearch(searchContext);

    // Calculate total matches
    const totalMatches = results.reduce(
      (sum, result) => sum + (result.matches?.length ?? 0),
      0,
    );

    // Handle results based on success/error state
    if (results.length > 0 && errors.length > 0) {
      return {
        success: true,
        message: `Search completed with warnings:\n${errors.join("\n")}`,
        results,
        totalMatches,
        matchedFiles: results.length,
      };
    }

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
