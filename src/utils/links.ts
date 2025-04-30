import { promises as fs } from "fs";
import path from "path";
import { unified, Processor } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { visit } from "unist-util-visit";
import { getAllMarkdownFiles } from "./files.js";
import type { Node, Parent } from "unist";
import type { Link, Delete, Text, Root } from "mdast";
import { VFileCompatible } from "vfile";

// Define WikiLink node type for AST traversal
interface WikiLinkNode extends Node {
  type: "wikiLink";
  value: string;
  data?: {
    alias?: string;
    permalink?: string;
  };
}

interface LinkUpdateOptions {
  filePath: string;
  oldPath: string;
  newPath?: string;
}

/**
 * Updates markdown links in a file using AST manipulation
 * @returns true if any links were updated
 */
export async function updateLinksInFile({
  filePath,
  oldPath,
  newPath,
}: LinkUpdateOptions): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (e) {
    console.error(`Error reading file ${filePath}:`, e);
    return false;
  }

  const oldName = path.basename(oldPath, ".md");
  const oldLinkTarget = oldPath.endsWith(".md") ? oldPath : oldPath + ".md";
  const oldWikiLinkTarget = oldName;

  const newName = newPath ? path.basename(newPath, ".md") : null;
  const newLinkTarget =
    newPath && (newPath.endsWith(".md") ? newPath : newPath + ".md");
  const newWikiLinkTarget = newName;

  let modified = false;
  let processor: any; // Use any type to avoid complex signature issues for now

  try {
    const wikiLinkPlugin = await import("remark-wiki-link").then(
      (m) => m.default || m,
    );
    processor = unified()
      .use(remarkParse)
      .use(remarkFrontmatter, ["yaml"])
      .use(remarkGfm)
      .use(wikiLinkPlugin)
      .use(remarkStringify, {
        bullet: "-",
        listItemIndent: "one",
      });
  } catch (err) {
    console.error("Failed to initialize remark processor:", err);
    return false;
  }

  // Check processor exists before using it
  if (!processor) {
    console.error("Processor is undefined after initialization attempt.");
    return false;
  }

  const tree = processor.parse(content);

  visit(tree, (node: Node, index?: number, parent?: Parent) => {
    if (index === undefined || parent === undefined) return;

    let nodeModified = false;

    if (node.type === "link") {
      const linkNode = node as Link;
      if (linkNode.url === oldLinkTarget) {
        if (newLinkTarget) {
          linkNode.url = newLinkTarget;
          nodeModified = true;
        } else {
          const deleteNode: Delete = { type: "delete", children: [linkNode] };
          parent.children.splice(index, 1, deleteNode);
          modified = true;
          return; // Skip further processing of replaced node
        }
      }
    }

    if (node.type === "wikiLink") {
      const wikiLinkNode = node as WikiLinkNode;
      if (wikiLinkNode.value === oldWikiLinkTarget) {
        if (newWikiLinkTarget) {
          wikiLinkNode.value = newWikiLinkTarget;
          if (wikiLinkNode.data)
            wikiLinkNode.data.permalink = newWikiLinkTarget;
          nodeModified = true;
        } else {
          // Reconstruct original text for strikethrough
          const originalText =
            wikiLinkNode.data?.alias &&
            wikiLinkNode.data.alias !== wikiLinkNode.value
              ? `[[${wikiLinkNode.value}|${wikiLinkNode.data.alias}]]`
              : `[[${wikiLinkNode.value}]]`;
          const textNode: Text = { type: "text", value: originalText };
          const deleteNode: Delete = { type: "delete", children: [textNode] };
          parent.children.splice(index, 1, deleteNode);
          modified = true;
          return; // Skip further processing of replaced node
        }
      }
    }

    if (nodeModified) {
      modified = true;
    }
  });

  if (modified) {
    try {
      // Check processor exists again (belt-and-suspenders)
      if (!processor) {
        console.error("Processor became undefined before stringify.");
        return false; // Should not happen if initial check passed
      }
      const result: VFileCompatible = processor.stringify(tree as Root);
      const newContent = result.toString();

      if (newContent.trim() !== content.trim()) {
        await fs.writeFile(filePath, newContent, "utf-8");
        return true;
      }
    } catch (e) {
      console.error(`Error writing file ${filePath} after link update:`, e);
      return false;
    }
  }

  return false;
}

/**
 * Updates all markdown links in the vault after a note is moved or deleted
 * @returns number of files updated
 */
export async function updateVaultLinks(
  vaultPath: string,
  oldPath: string | null | undefined,
  newPath: string | null | undefined,
): Promise<number> {
  if (!oldPath) return 0;

  const files = await getAllMarkdownFiles(vaultPath);
  let updatedFiles = 0;

  for (const file of files) {
    // Skip the target file itself if it's being moved TO this location
    if (newPath && file === path.join(vaultPath, newPath)) continue;
    // Don't process the file that is being deleted/moved FROM
    if (file === path.join(vaultPath, oldPath)) continue;

    try {
      if (
        await updateLinksInFile({
          filePath: file,
          oldPath: oldPath,
          newPath: newPath || undefined,
        })
      ) {
        updatedFiles++;
      }
    } catch (error) {
      console.error(`Failed to update links in file ${file}:`, error);
    }
  }

  return updatedFiles;
}
