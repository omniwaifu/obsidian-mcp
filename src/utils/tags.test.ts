// tags.test.ts

import { describe, it, expect } from "bun:test";
import {
  validateTag,
  normalizeTag,
  parseNote,
  stringifyNote,
  extractTags,
  addTagsToFrontmatter,
  removeTagsFromFrontmatter,
  removeInlineTags,
  isParentTag,
  matchesTagPattern,
  getRelatedTags,
} from "./tags";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

describe("Tag Utilities", () => {
  // --- Tests for validateTag ---
  describe("validateTag", () => {
    it("should return true for valid tags", () => {
      expect(validateTag("simple")).toBe(true);
      expect(validateTag("#simple")).toBe(true);
      expect(validateTag("with/hierarchy")).toBe(true);
      expect(validateTag("#with/hierarchy")).toBe(true);
      expect(validateTag("tag123")).toBe(true);
      expect(validateTag("a/b/c/d1")).toBe(true);
    });

    it("should return false for invalid tags", () => {
      expect(validateTag("")).toBe(false);
      expect(validateTag("#")).toBe(false);
      expect(validateTag("with space")).toBe(false);
      expect(validateTag("#with space")).toBe(false);
      expect(validateTag("special-char")).toBe(false);
      expect(validateTag("tag!")).toBe(false);
      expect(validateTag("/leading")).toBe(false);
      expect(validateTag("trailing/")).toBe(false);
      expect(validateTag("double//slash")).toBe(false);
    });
  });

  // --- Tests for normalizeTag ---
  describe("normalizeTag", () => {
    it("should normalize tags correctly", () => {
      expect(normalizeTag("SimpleTag")).toBe("simple-tag");
      expect(normalizeTag("#simpleTag")).toBe("simple-tag");
      expect(normalizeTag("already-kebab")).toBe("already-kebab");
      expect(normalizeTag("With/HierarchyTag")).toBe("with/hierarchy-tag");
      expect(normalizeTag("#With/HierarchyTAG")).toBe("with/hierarchy-tag");
      expect(normalizeTag("ALLCAPS")).toBe("allcaps");
      expect(normalizeTag("Num123Tag")).toBe("num123-tag");
    });

    it("should not normalize if normalize flag is false", () => {
      expect(normalizeTag("SimpleTag", false)).toBe("SimpleTag");
      expect(normalizeTag("#simpleTag", false)).toBe("simpleTag");
      expect(normalizeTag("With/HierarchyTag", false)).toBe(
        "With/HierarchyTag",
      );
    });
  });

  // --- Tests for parseNote ---
  describe("parseNote", () => {
    it("should parse note with frontmatter", () => {
      const content =
        "---\nkey: value\ntags: [tag1, tag2]\naliases:\n  - alias1\n---\n\nBody content";
      const parsed = parseNote(content);
      expect(parsed.hasFrontmatter).toBe(true);
      expect(parsed.frontmatter).toEqual({
        key: "value",
        tags: ["tag1", "tag2"],
        aliases: ["alias1"],
      });
      expect(parsed.content.trim()).toBe("Body content");
    });

    it("should parse note without frontmatter", () => {
      const content = "Just body content";
      const parsed = parseNote(content);
      expect(parsed.hasFrontmatter).toBe(false);
      expect(parsed.frontmatter).toEqual({});
      expect(parsed.content).toBe("Just body content");
    });

    it("should parse note with empty frontmatter block", () => {
      const content = "---\n---\nBody content";
      const parsed = parseNote(content);
      expect(parsed.hasFrontmatter).toBe(true);
      expect(parsed.frontmatter).toEqual({}); // yaml library parses empty block to null or {}, let's assume {}
      expect(parsed.content.trim()).toBe("Body content");
    });

    it("should throw McpError for invalid frontmatter YAML", () => {
      const content = "---\ninvalid: yaml: here\n---\nBody content";
      expect(() => parseNote(content)).toThrow(McpError);
    });

    it("should parse note with frontmatter only", () => {
      const content = `---
key: value
---`; // Use backticks
      const parsed = parseNote(content);
      expect(parsed.hasFrontmatter).toBe(true);
      expect(parsed.frontmatter).toEqual({ key: "value" });
      expect(parsed.content).toBe("");
    });
  });

  // --- Tests for stringifyNote ---
  describe("stringifyNote", () => {
    it("should stringify note with frontmatter", () => {
      const parsed = {
        frontmatter: { key: "value", tags: ["t1"] },
        content: "Body content",
        hasFrontmatter: true,
      };
      const expected = "---\nkey: value\ntags:\n  - t1\n---\n\nBody content";
      // Normalize whitespace/newlines for comparison
      expect(stringifyNote(parsed).replace(/\s+/g, " ")).toBe(
        expected.replace(/\s+/g, " "),
      );
    });

    it("should stringify note without frontmatter", () => {
      const parsed = {
        frontmatter: {},
        content: "Body content",
        hasFrontmatter: false,
      };
      expect(stringifyNote(parsed)).toBe("Body content");
    });

    it("should stringify note with empty frontmatter object", () => {
      const parsed = {
        frontmatter: {},
        content: "Body content",
        hasFrontmatter: true, // Even if hasFrontmatter is true, empty object shouldn't render
      };
      expect(stringifyNote(parsed)).toBe("Body content");
    });
  });

  // --- Tests for extractTags ---
  describe("extractTags", () => {
    it("should extract simple and hierarchical tags", () => {
      const content = "This note has #tag1 and #tag/two.";
      expect(extractTags(content).sort()).toEqual(["tag/two", "tag1"].sort());
    });

    it("should extract unique tags", () => {
      const content = "#tag1 #tag2 #tag1";
      expect(extractTags(content).sort()).toEqual(["tag1", "tag2"].sort());
    });

    it("should ignore tags in code blocks (```)", () => {
      const content = "```\nThis is code #notatag\n```\nThis is #real/tag";
      expect(extractTags(content)).toEqual(["real/tag"]);
    });

    it("should ignore tags in inline code (`)", () => {
      const content = "This is `#notatag` but this is #atag.";
      expect(extractTags(content)).toEqual(["atag"]);
    });

    it("should ignore tags in HTML comments (<!-- -->)", () => {
      const content = "<!-- #commenttag -->\n#realtag";
      expect(extractTags(content)).toEqual(["realtag"]);
    });

    it("should handle multi-line code blocks and comments", () => {
      const content = `
Start #tag1
\`\`\`
#code-tag
\`\`\`
Middle #tag2
<!--
#comment-tag
-->
End #tag3
      `;
      expect(extractTags(content).sort()).toEqual(
        ["tag1", "tag2", "tag3"].sort(),
      );
    });
  });

  // --- Tests for isParentTag ---
  describe("isParentTag", () => {
    it("should correctly identify parent tags", () => {
      expect(isParentTag("a", "a/b")).toBe(true);
      expect(isParentTag("a/b", "a/b/c")).toBe(true);
      expect(isParentTag("project", "project/alpha")).toBe(true);
    });
    it("should correctly identify non-parent tags", () => {
      expect(isParentTag("a/b", "a")).toBe(false);
      expect(isParentTag("a", "a")).toBe(false);
      expect(isParentTag("a", "b/a")).toBe(false);
      expect(isParentTag("project/alpha", "project")).toBe(false);
    });
  });

  // --- Tests for matchesTagPattern ---
  describe("matchesTagPattern", () => {
    it("should match exact tags", () => {
      expect(matchesTagPattern("tag1", "tag1")).toBe(true);
      expect(matchesTagPattern("tag1", "tag2")).toBe(false);
    });
    it("should match patterns with wildcards", () => {
      expect(matchesTagPattern("tag*", "tag1")).toBe(true);
      expect(matchesTagPattern("tag*", "tag-anything")).toBe(true);
      expect(matchesTagPattern("*tag", "leading-tag")).toBe(true);
      expect(matchesTagPattern("ta*g", "tag")).toBe(true);
      expect(matchesTagPattern("ta*g", "ta-middle-g")).toBe(true);
    });
    it("should match hierarchical patterns with wildcards", () => {
      expect(matchesTagPattern("project/*", "project/alpha")).toBe(true);
      expect(matchesTagPattern("project/*", "project/beta/task")).toBe(true);
      expect(matchesTagPattern("*/tasks", "project/tasks")).toBe(true);
      expect(matchesTagPattern("project/*/tasks", "project/alpha/tasks")).toBe(
        true,
      );
      expect(matchesTagPattern("project/*", "other/alpha")).toBe(false);
    });
  });

  // --- Tests for getRelatedTags ---
  describe("getRelatedTags", () => {
    const allTags = ["a", "a/b", "a/b/c", "a/d", "b", "b/c"];
    it("should get children tags", () => {
      expect(getRelatedTags("a", allTags).children.sort()).toEqual(
        ["a/b", "a/d"].sort(),
      );
      expect(getRelatedTags("a/b", allTags).children.sort()).toEqual(
        ["a/b/c"].sort(),
      );
      expect(getRelatedTags("b", allTags).children.sort()).toEqual(
        ["b/c"].sort(),
      );
      expect(getRelatedTags("c", allTags).children.sort()).toEqual([].sort()); // No children
    });
    it("should get parent tags", () => {
      expect(getRelatedTags("a/b/c", allTags).parents.sort()).toEqual(
        ["a", "a/b"].sort(),
      );
      expect(getRelatedTags("a/d", allTags).parents.sort()).toEqual(
        ["a"].sort(),
      );
      expect(getRelatedTags("b/c", allTags).parents.sort()).toEqual(
        ["b"].sort(),
      );
      expect(getRelatedTags("a", allTags).parents.sort()).toEqual([].sort()); // No parents
    });
  });

  // --- Tests for addTagsToFrontmatter ---
  describe("addTagsToFrontmatter", () => {
    it("should add tags to existing array", () => {
      const fm: Record<string, any> = { tags: ["t1"] };
      addTagsToFrontmatter(fm, ["t2", "t3"]);
      expect(fm.tags?.sort()).toEqual(["t1", "t2", "t3"].sort());
    });
    it("should add tags as new array", () => {
      const fm: Record<string, any> = { other: "value" };
      addTagsToFrontmatter(fm, ["t1", "t2"]);
      expect(fm.tags?.sort()).toEqual(["t1", "t2"].sort());
    });
    it("should add tags as string if single tag and no existing", () => {
      const fm: Record<string, any> = {};
      addTagsToFrontmatter(fm, ["t1"]);
      expect(fm.tags).toBe("t1");
    });
    it("should convert existing string tag to array", () => {
      const fm: Record<string, any> = { tags: "t1" };
      addTagsToFrontmatter(fm, ["t2"]);
      expect(Array.isArray(fm.tags)).toBe(true);
      expect(fm.tags?.sort()).toEqual(["t1", "t2"].sort());
    });
    it("should handle duplicate tags", () => {
      const fm: Record<string, any> = { tags: ["t1"] };
      addTagsToFrontmatter(fm, ["t1", "t2"]);
      expect(fm.tags?.sort()).toEqual(["t1", "t2"].sort());
    });
  });

  // --- Tests for removeTagsFromFrontmatter ---
  describe("removeTagsFromFrontmatter", () => {
    it("should remove tags from array", () => {
      const fm = { tags: ["t1", "t2", "t3"] };
      removeTagsFromFrontmatter(fm, ["t2"]);
      expect(fm.tags?.sort()).toEqual(["t1", "t3"].sort());
    });
    it("should remove tag string if it matches", () => {
      const fm = { tags: "t1" };
      removeTagsFromFrontmatter(fm, ["t1"]);
      expect(fm.tags).toBeUndefined();
    });
    it("should not remove tag string if it doesn't match", () => {
      const fm: Record<string, any> = { tags: "t1" };
      removeTagsFromFrontmatter(fm, ["t2"]);
      expect(Array.isArray(fm.tags)).toBe(true);
      expect(fm.tags as string[]).toEqual(["t1"]);
    });
    it("should remove multiple tags", () => {
      const fm: Record<string, any> = { tags: ["t1", "t2", "t3"] };
      removeTagsFromFrontmatter(fm, ["t1", "t3"]);
      expect(Array.isArray(fm.tags)).toBe(true);
      expect(fm.tags as string[]).toEqual(["t2"]);
    });
    it("should remove tags key if array becomes empty", () => {
      const fm: Record<string, any> = { tags: ["t1", "t2"] };
      removeTagsFromFrontmatter(fm, ["t1", "t2"]);
      // Check that the key itself was deleted
      expect(fm.hasOwnProperty("tags")).toBe(false);
      expect(fm.tags).toBeUndefined();
    });
    it("should remove tag string if it matches and remain as an array", () => {
      const fm = { tags: "t1" };
      removeTagsFromFrontmatter(fm, ["t2"]);
      expect(Array.isArray(fm.tags)).toBe(true);
      expect(fm.tags as unknown as string[]).toEqual(["t1"]);
    });
  });

  // --- Tests for removeInlineTags ---
  describe("removeInlineTags", () => {
    it("should remove specified inline tags", () => {
      const content = "Keep #tag1, remove #tag2 and #tag/three.";
      const expected = "Keep #tag1, remove  and .";
      const result = removeInlineTags(content, ["tag2", "tag/three"]);
      expect(result.content).toBe(expected);
    });
    it("should not remove tags in code blocks", () => {
      const content = "```\n#tag1\n```\nRemove #tag2";
      const expected = "```\n#tag1\n```\nRemove ";
      const result = removeInlineTags(content, ["tag1", "tag2"]);
      expect(result.content).toBe(expected);
    });
  });
});
