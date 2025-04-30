import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

interface ParsedNote {
  frontmatter: Record<string, any>;
  content: string;
  hasFrontmatter: boolean;
}

interface TagChange {
  tag: string;
  location: "frontmatter" | "content";
  line?: number;
  context?: string;
}

interface TagRemovalReport {
  removedTags: TagChange[];
  preservedTags: TagChange[];
  errors: string[];
}

/**
 * Checks if tagA is a parent of tagB in a hierarchical structure
 */
export function isParentTag(parentTag: string, childTag: string): boolean {
  return childTag.startsWith(parentTag + "/");
}

/**
 * Matches a tag against a pattern
 * Supports * wildcard and hierarchical matching
 */
export function matchesTagPattern(pattern: string, tag: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern.replace(/\*/g, ".*").replace(/\//g, "\\/");
  return new RegExp(`^${regexPattern}$`).test(tag);
}

/**
 * Gets all related tags (parent/child) for a given tag
 */
export function getRelatedTags(
  tag: string,
  allTags: string[],
): {
  parents: string[];
  children: string[];
} {
  const parents: string[] = [];
  const children: string[] = [];

  const parts = tag.split("/");
  let current = "";

  // Find parents
  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    parents.push(current);
  }

  // Find *direct* children
  allTags.forEach((otherTag) => {
    if (isParentTag(tag, otherTag)) {
      // Check if it's a direct child (no further '/' after the parent part)
      const childPart = otherTag.substring(tag.length + 1); // +1 for the '/'
      if (!childPart.includes("/")) {
        children.push(otherTag);
      }
    }
  });

  return { parents, children };
}

/**
 * Validates a tag format
 * Allows: #tag, tag, tag/subtag, project/active
 * Disallows: empty strings, spaces, special characters except '/'
 */
export function validateTag(tag: string): boolean {
  // Remove leading # if present
  tag = tag.replace(/^#/, "");

  // Check if tag is empty
  if (!tag) return false;

  // Basic tag format validation
  const TAG_REGEX = /^[a-zA-Z0-9]+(\/[a-zA-Z0-9]+)*$/;
  return TAG_REGEX.test(tag);
}

/**
 * Normalizes a tag to a consistent format
 * Example: ProjectActive -> project-active
 */
export function normalizeTag(tag: string, normalize = true): string {
  // Remove leading # if present
  tag = tag.replace(/^#/, "");

  if (!normalize) return tag;

  // Convert camelCase/PascalCase to kebab-case
  return tag
    .split("/")
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())
    .join("/");
}

/**
 * Parses a note's content into frontmatter and body
 */
export function parseNote(content: string): ParsedNote {
  // Regex updated to handle optional CR, optional final newline after closing ---, and empty frontmatter
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  // Special case for empty frontmatter
  const emptyFrontmatterRegex = /^---\r?\n---\r?\n?([\s\S]*)$/;

  const emptyMatch = content.match(emptyFrontmatterRegex);
  if (emptyMatch) {
    return {
      frontmatter: {},
      content: emptyMatch[1] || "", // Ensure content is string even if empty
      hasFrontmatter: true,
    };
  }

  const match = content.match(frontmatterRegex);

  if (!match) {
    return {
      frontmatter: {},
      content: content,
      hasFrontmatter: false,
    };
  }

  try {
    const frontmatter = parseYaml(match[1]);
    return {
      frontmatter: frontmatter || {},
      content: match[2],
      hasFrontmatter: true,
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Invalid frontmatter YAML format",
    );
  }
}

/**
 * Combines frontmatter and content back into a note
 */
export function stringifyNote(parsed: ParsedNote): string {
  if (!parsed.hasFrontmatter || Object.keys(parsed.frontmatter).length === 0) {
    return parsed.content;
  }

  const frontmatterStr = stringifyYaml(parsed.frontmatter).trim();
  return `---\n${frontmatterStr}\n---\n\n${parsed.content.trim()}`;
}

/**
 * Extracts all tags from a note's content
 */
export function extractTags(content: string): string[] {
  const tags = new Set<string>();

  // Regex refined: Match # followed by allowed chars, ensure it's followed by a non-tag character or end of line
  // Allowed: letters, numbers, /, _, -
  // (Removed '.' from allowed chars as it's often punctuation)
  const TAG_PATTERN = /(?<![\w`])#([a-zA-Z0-9/_-]+)(?![a-zA-Z0-9/_-])/g;

  const lines = content.split("\n");
  let inCodeBlock = false;
  let inHtmlComment = false;

  for (const line of lines) {
    let currentLine = line;
    let processLine = true;

    // Check for HTML comment boundaries across lines
    if (inHtmlComment) {
      if (currentLine.includes("-->")) {
        inHtmlComment = false;
        currentLine = currentLine.substring(currentLine.indexOf("-->") + 3);
      } else {
        processLine = false; // Still inside comment block
      }
    }
    // Check for code block boundaries
    // Needs to be checked *after* potential HTML comment end on the same line
    if (processLine && currentLine.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      processLine = false; // Don't process the fence line itself
    }

    if (processLine && !inCodeBlock) {
      // Find tags on the line, considering potential start of HTML comment
      let searchLine = currentLine;
      if (currentLine.includes("<!--")) {
        searchLine = currentLine.substring(0, currentLine.indexOf("<!--"));
        // If comment doesn't close on same line, set flag for next iteration
        if (
          !currentLine.substring(currentLine.indexOf("<!--")).includes("-->")
        ) {
          inHtmlComment = true;
        }
      }

      const matches = searchLine.match(TAG_PATTERN);
      if (matches) {
        matches.forEach((tagMatch) => {
          // Use the refined regex to capture the tag part correctly (Group 1)
          const tag = tagMatch.match(/#([a-zA-Z0-9/_-]+)/)?.[1];
          if (!tag) return;

          // Ensure tag doesn't immediately follow a backtick (inline code)
          const index = searchLine.indexOf(tagMatch);
          if (index > 0 && searchLine[index - 1] === "`") {
            // Skip inline code tag
          } else {
            tags.add(tag); // Add captured group 1 (without #)
          }
        });
      }
    }
  }

  return Array.from(tags);
}

/**
 * Safely adds tags to frontmatter (modifies in-place)
 */
export function addTagsToFrontmatter(
  frontmatter: Record<string, any>, // Modifies this object directly
  newTags: string[],
  normalize = true,
): void {
  // Returns void as it modifies in-place
  // Handle existing tags (string or array)
  let existingTagsArray: string[] = [];
  if (typeof frontmatter.tags === "string") {
    existingTagsArray = [frontmatter.tags];
  } else if (Array.isArray(frontmatter.tags)) {
    existingTagsArray = frontmatter.tags;
  }
  const existingTags = new Set(existingTagsArray);

  for (const tag of newTags) {
    if (!validateTag(tag)) {
      // Keep original behavior: throw for invalid tags during add
      throw new McpError(ErrorCode.InvalidParams, `Invalid tag format: ${tag}`);
    }
    existingTags.add(normalizeTag(tag, normalize));
  }

  // Update the frontmatter object directly
  if (existingTags.size > 0) {
    // Obsidian convention: single tag as string, multiple as array
    if (existingTags.size === 1) {
      frontmatter.tags = Array.from(existingTags)[0];
    } else {
      frontmatter.tags = Array.from(existingTags).sort();
    }
  } else {
    delete frontmatter.tags; // Remove if empty
  }
}

/**
 * Safely removes tags from frontmatter with detailed reporting (modifies in-place)
 */
export function removeTagsFromFrontmatter(
  frontmatter: Record<string, any>, // Modifies this object directly
  tagsToRemove: string[],
  options: {
    normalize?: boolean;
    // preserveChildren?: boolean; // TODO: Implement preserveChildren if needed
    patterns?: string[];
  } = {},
): {
  // frontmatter: Record<string, any>; // No longer returns frontmatter
  report: {
    removed: TagChange[];
    preserved: TagChange[];
  };
} {
  const {
    normalize = true,
    // preserveChildren = false, // TODO
    patterns = [],
  } = options;

  // Handle existing tags (string or array)
  let currentTags: string[] = [];
  if (typeof frontmatter.tags === "string") {
    currentTags = [frontmatter.tags];
  } else if (Array.isArray(frontmatter.tags)) {
    currentTags = frontmatter.tags;
  }

  const removed: TagChange[] = [];
  const preserved: TagChange[] = [];
  const tagsToRemoveNormalized = new Set(
    tagsToRemove.map((t) => normalizeTag(t, normalize)),
  );
  const patternsRegex = patterns.map(
    (p) => new RegExp(`^${p.replace(/\*/g, ".*").replace(/\//g, "\\/")}$`),
  );

  const remainingTags = currentTags.filter((tag) => {
    const normalizedTag = normalizeTag(tag, normalize);
    const shouldRemove =
      tagsToRemoveNormalized.has(normalizedTag) ||
      patternsRegex.some((re) => re.test(normalizedTag));

    if (shouldRemove) {
      // TODO: Add preserveChildren logic here if re-enabled
      removed.push({ tag: tag, location: "frontmatter" });
      return false; // Filter out
    } else {
      preserved.push({ tag: tag, location: "frontmatter" });
      return true; // Keep
    }
  });

  // Update the frontmatter object directly
  if (remainingTags.length === 0) {
    delete frontmatter.tags;
  } else {
    // Always store as array internally, even if just one tag remains
    // Obsidian handles rendering single-element array as string if needed
    frontmatter.tags = remainingTags.sort();
  }

  return { report: { removed, preserved } };
}

/**
 * Removes inline tags from content with detailed reporting
 */
export function removeInlineTags(
  content: string,
  tagsToRemove: string[],
  options: {
    normalize?: boolean;
    preserveChildren?: boolean;
    patterns?: string[];
  } = {},
): {
  content: string;
  report: {
    removed: TagChange[];
    preserved: TagChange[];
  };
} {
  const { normalize = true, preserveChildren = false, patterns = [] } = options;

  const removed: TagChange[] = [];
  const preserved: TagChange[] = [];

  // Process content line by line to track context
  const lines = content.split("\n");
  let inCodeBlock = false;
  let inHtmlComment = false;
  let modifiedLines = lines.map((line, lineNum) => {
    // Track code blocks and comments
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (line.includes("<!--")) inHtmlComment = true;
    if (line.includes("-->")) inHtmlComment = false;
    if (inCodeBlock || inHtmlComment) {
      // Preserve tags in code blocks and comments
      const tags = line.match(/(?<!`)#[a-zA-Z0-9][a-zA-Z0-9/]*(?!`)/g) || [];
      tags.forEach((tag) => {
        preserved.push({
          tag: tag.slice(1),
          location: "content",
          line: lineNum + 1,
          context: line.trim(),
        });
      });
      return line;
    }

    // Process tags in regular content
    return line.replace(/(?<!`)#[a-zA-Z0-9][a-zA-Z0-9/]*(?!`)/g, (match) => {
      const tag = match.slice(1); // Remove # prefix
      const normalizedTag = normalizeTag(tag, normalize);

      const shouldRemove = tagsToRemove.some((removeTag) => {
        // Direct match
        if (normalizeTag(removeTag, normalize) === normalizedTag) return true;

        // Pattern match
        if (
          patterns.some((pattern) => matchesTagPattern(pattern, normalizedTag))
        ) {
          return true;
        }

        // Hierarchical match (if not preserving children)
        if (!preserveChildren && isParentTag(removeTag, normalizedTag)) {
          return true;
        }

        return false;
      });

      if (shouldRemove) {
        removed.push({
          tag: normalizedTag,
          location: "content",
          line: lineNum + 1,
          context: line.trim(),
        });
        return "";
      } else {
        preserved.push({
          tag: normalizedTag,
          location: "content",
          line: lineNum + 1,
          context: line.trim(),
        });
        return match;
      }
    });
  });

  // Clean up empty lines created by tag removal
  modifiedLines = modifiedLines.reduce((acc: string[], line: string) => {
    if (line.trim() === "") {
      if (acc[acc.length - 1]?.trim() === "") {
        return acc;
      }
    }
    acc.push(line);
    return acc;
  }, []);

  return {
    content: modifiedLines.join("\n"),
    report: { removed, preserved },
  };
}
