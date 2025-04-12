import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import path from 'path';
import fsPromises from 'fs/promises';
import {
  getAllMarkdownFiles,
  getAllNonMarkdownFiles,
  ensureDirectory,
  fileExists,
  safeReadFile,
} from './files';
import { normalizePath } from './path'; // Needed for comparisons

// Define a temporary directory for test files
const testDir = path.resolve('.test-temp-files');
const vaultPath = path.join(testDir, 'TestVault');

describe('File Utilities', () => {
  // Setup: Create temporary directory structure before all tests
  beforeAll(async () => {
    // Explicitly import original fs functions
    const fs = await import('fs/promises');
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(vaultPath, { recursive: true });
    await fs.mkdir(path.join(vaultPath, 'SubFolder'), { recursive: true });
    await fs.mkdir(path.join(vaultPath, '.hiddenFolder'), { recursive: true });
    await fs.mkdir(path.join(vaultPath, '.obsidian'), { recursive: true }); // Special hidden folder

    // Create dummy files
    await fs.writeFile(path.join(vaultPath, 'note1.md'), 'content1');
    await fs.writeFile(path.join(vaultPath, 'note2.md'), 'content2');
    await fs.writeFile(path.join(vaultPath, 'image.png'), 'pngdata');
    await fs.writeFile(path.join(vaultPath, 'document.pdf'), 'pdfdata');
    await fs.writeFile(path.join(vaultPath, 'SubFolder', 'subnote1.md'), 'subcontent1');
    await fs.writeFile(path.join(vaultPath, 'SubFolder', 'data.json'), '{}');
    await fs.writeFile(path.join(vaultPath, '.hiddenFolder', 'hidden_note.md'), 'hidden_md');
    await fs.writeFile(path.join(vaultPath, '.hiddenFolder', 'hidden_data.txt'), 'hidden_txt');
    await fs.writeFile(path.join(vaultPath, '.obsidian', 'config'), 'obsidian_config');
    await fs.writeFile(path.join(vaultPath, '.DS_Store'), 'ds_store_data');
  });

  // Teardown: Remove temporary directory after all tests
  afterAll(async () => {
    // Explicitly import original fs functions
    const fs = await import('fs/promises');
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // --- Tests for getAllMarkdownFiles --- 
  describe('getAllMarkdownFiles', () => {
    it('should find all markdown files recursively', async () => {
      const files = await getAllMarkdownFiles(vaultPath);
      const relativeFiles = files.map(f => path.relative(vaultPath, f)).sort();
      // Expect note1.md, note2.md, SubFolder/subnote1.md
      // Should exclude hidden folders and .obsidian
      expect(relativeFiles).toEqual([
        'SubFolder/subnote1.md',
        'note1.md',
        'note2.md',
      ].sort());
    });

    it('should find markdown files within a specific sub-directory', async () => {
      const subFolderPath = path.join(vaultPath, 'SubFolder');
      const files = await getAllMarkdownFiles(vaultPath, subFolderPath);
      const relativeFiles = files.map(f => path.relative(vaultPath, f)).sort();
      expect(relativeFiles).toEqual(['SubFolder/subnote1.md']);
    });

    it('should return empty array if no markdown files exist in scope', async () => {
       const fs = await import('fs/promises'); // Import for mkdir/rmdir
       const emptySubDir = path.join(vaultPath, 'EmptySubFolder');
       await fs.mkdir(emptySubDir);
       const files = await getAllMarkdownFiles(vaultPath, emptySubDir);
       expect(files).toEqual([]);
       await fs.rmdir(emptySubDir); // Use rmdir for empty directory
    });

     it('should throw error for search directory outside vault', async () => {
       const outsidePath = path.resolve(testDir, 'OutsideDir');
       await expect(getAllMarkdownFiles(vaultPath, outsidePath)).rejects.toThrow();
    });
  });

  // --- Tests for getAllNonMarkdownFiles --- 
  describe('getAllNonMarkdownFiles', () => {
    it('should find all non-markdown files recursively, excluding hidden/system', async () => {
      const files = await getAllNonMarkdownFiles(vaultPath);
      const relativeFiles = files.map(f => path.relative(vaultPath, f)).sort();
      // Expect image.png, document.pdf, SubFolder/data.json
      // Should exclude .md files, .hiddenFolder, .obsidian, .DS_Store
      expect(relativeFiles).toEqual([
        'SubFolder/data.json',
        'document.pdf',
        'image.png',
      ].sort());
    });

     it('should find non-markdown files within a specific sub-directory', async () => {
      const subFolderPath = path.join(vaultPath, 'SubFolder');
      const files = await getAllNonMarkdownFiles(vaultPath, subFolderPath);
      const relativeFiles = files.map(f => path.relative(vaultPath, f)).sort();
      expect(relativeFiles).toEqual(['SubFolder/data.json']);
    });

    it('should return empty array if no non-markdown files exist (respecting exclusions)', async () => {
      // Test in .hiddenFolder, which only contains excluded files after initial filtering
      const hiddenFolderPath = path.join(vaultPath, '.hiddenFolder');
      const files = await getAllNonMarkdownFiles(vaultPath, hiddenFolderPath);
      expect(files).toEqual([]);
    });
  });

  // --- Tests for fileExists --- 
  describe('fileExists', () => {
    it('should return true for an existing file', async () => {
      expect(await fileExists(path.join(vaultPath, 'note1.md'))).toBe(true);
    });

    it('should return false for a non-existent file', async () => {
      expect(await fileExists(path.join(vaultPath, 'nonexistent.txt'))).toBe(false);
    });

    it('should return false for a directory', async () => {
      expect(await fileExists(path.join(vaultPath, 'SubFolder'))).toBe(false);
    });
  });

  // --- Tests for ensureDirectory --- 
  describe('ensureDirectory', () => {
    const newDirPath = path.join(vaultPath, 'NewTestDir');
    const nestedDirPath = path.join(vaultPath, 'Nested', 'Test', 'Dir');

    afterEach(async () => {
      const fs = await import('fs/promises'); // Import for rm
      await fs.rm(newDirPath, { recursive: true, force: true }).catch(() => {});
      await fs.rm(path.join(vaultPath, 'Nested'), { recursive: true, force: true }).catch(() => {});
    });

    it('should create a directory if it does not exist', async () => {
      const fs = await import('fs/promises'); // Import for stat
      await ensureDirectory(newDirPath);
      const stats = await fs.stat(newDirPath);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should not throw if the directory already exists', async () => {
      await ensureDirectory(newDirPath); // Create first time
      await expect(ensureDirectory(newDirPath)).resolves.toBeUndefined(); // Should succeed
    });

    it('should create nested directories recursively', async () => {
       const fs = await import('fs/promises'); // Import for stat
      await ensureDirectory(nestedDirPath);
      const stats = await fs.stat(nestedDirPath);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  // --- Tests for safeReadFile --- 
  describe('safeReadFile', () => {
    it('should read content of an existing file', async () => {
      const content = await safeReadFile(path.join(vaultPath, 'note1.md'));
      expect(content).toBe('content1');
    });

    it('should return undefined for a non-existent file', async () => {
      const content = await safeReadFile(path.join(vaultPath, 'nonexistent.txt'));
      expect(content).toBeUndefined();
    });

    it('should throw McpError when trying to read a directory', async () => {
      // fs.readFile throws EISDIR error for directories
      await expect(safeReadFile(path.join(vaultPath, 'SubFolder'))).rejects.toThrow();
      // Ideally check for specific McpError type/code if needed
    });
  });
}); 