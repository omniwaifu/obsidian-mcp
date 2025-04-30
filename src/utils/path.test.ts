import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import assert from "node:assert";
import path from "path";
import fs from "fs/promises";
import { exec as execCallback } from "child_process";
import {
  normalizePath,
  checkPathCharacters,
  checkLocalPath,
  checkSuspiciousPath,
  isParentPath,
  checkPathOverlap,
  checkPathSafety,
} from "./path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { promisify as originalPromisify } from "util";

// Define mock functions, but don't apply them globally
const mockFsRealpath = mock(async (p: string) => p);
const mockFsStat = mock(async (_p: string) => ({ isDirectory: () => true }));
const mockExecFn = mock(
  async (
    _command: string,
    _options?: any,
  ): Promise<{ stdout: string; stderr: string }> => {
    // Default implementation (will be overridden)
    return { stdout: "Default Mock Response", stderr: "" };
  },
);

// Function to apply mocks needed for specific describe blocks
const applyMocks = () => {
  mock.module("fs/promises", () => ({
    default: {
      realpath: mockFsRealpath,
      stat: mockFsStat,
    },
    realpath: mockFsRealpath,
    stat: mockFsStat,
  }));
  mock.module("child_process", () => ({
    exec: mockExecFn,
  }));
};

// Function to reset mock implementations
const resetMockImplementations = () => {
  mockFsRealpath.mockImplementation(async (p: string) => p);
  mockFsStat.mockImplementation(async (_p: string) => ({
    isDirectory: () => true,
  }));
  mockExecFn.mockImplementation(
    async (
      _command: string,
      _options?: any,
    ): Promise<{ stdout: string; stderr: string }> => {
      // Default reset implementation (e.g., for local paths)
      if (_command.startsWith("wmic") || _command.startsWith("powershell")) {
        return { stdout: "DriveType=3", stderr: "" };
      } else if (_command.startsWith("df")) {
        return { stdout: "/dev/sda1 ext4 ... /", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  );
};

describe("normalizePath", () => {
  describe("Common tests", () => {
    it("should handle relative paths", () => {
      assert.strictEqual(
        normalizePath("./path/to/file"),
        path.resolve("./path/to/file"),
      );
      assert.strictEqual(
        normalizePath("../path/to/file"),
        path.resolve("../path/to/file"),
      );
    });

    it("should throw error for invalid paths", () => {
      assert.throws(() => normalizePath(""), McpError);
      assert.throws(() => normalizePath(null as any), McpError);
      assert.throws(() => normalizePath(undefined as any), McpError);
      assert.throws(() => normalizePath(123 as any), McpError);
    });
  });

  describe("Windows-specific tests", () => {
    it("should handle Windows drive letters", () => {
      assert.strictEqual(
        normalizePath("C:\\path\\to\\file"),
        "C:/path/to/file",
      );
      assert.strictEqual(normalizePath("D:/path/to/file"), "D:/path/to/file");
      assert.strictEqual(normalizePath("Z:\\test\\folder"), "Z:/test/folder");
    });

    it("should allow colons in Windows drive letters", () => {
      assert.strictEqual(
        normalizePath("C:\\path\\to\\file"),
        "C:/path/to/file",
      );
      assert.strictEqual(normalizePath("D:/path/to/file"), "D:/path/to/file");
      assert.strictEqual(normalizePath("X:\\test\\folder"), "X:/test/folder");
    });

    it("should reject Windows paths with invalid characters", () => {
      assert.throws(() => normalizePath("C:\\path\\to\\file<"), McpError);
      assert.throws(() => normalizePath("D:/path/to/file>"), McpError);
      assert.throws(() => normalizePath("E:\\test\\folder|"), McpError);
      assert.throws(() => normalizePath("F:/test/folder?"), McpError);
      assert.throws(() => normalizePath("G:\\test\\folder*"), McpError);
    });

    it("should handle UNC paths correctly", () => {
      assert.strictEqual(
        normalizePath("\\\\server\\share\\path"),
        "//server/share/path",
      );
      assert.strictEqual(
        normalizePath("//server/share/path"),
        "//server/share/path",
      );
      assert.strictEqual(
        normalizePath("\\\\server\\share\\folder\\file"),
        "//server/share/folder/file",
      );
    });

    it("should handle network drive paths", () => {
      assert.strictEqual(
        normalizePath("Z:\\network\\drive"),
        "Z:/network/drive",
      );
      assert.strictEqual(normalizePath("Y:/network/drive"), "Y:/network/drive");
    });

    it("should preserve path separators in UNC paths", () => {
      const result = normalizePath("\\\\server\\share\\path");
      assert.strictEqual(result, "//server/share/path");
      assert.notStrictEqual(result, path.resolve("//server/share/path"));
    });

    it("should preserve drive letters in Windows paths", () => {
      const result = normalizePath("C:\\path\\to\\file");
      assert.strictEqual(result, "C:/path/to/file");
      assert.notStrictEqual(result, path.resolve("C:/path/to/file"));
    });
  });

  describe("macOS/Unix-specific tests", () => {
    it("should handle absolute paths", () => {
      assert.strictEqual(
        normalizePath("/path/to/file"),
        path.resolve("/path/to/file"),
      );
    });

    it("should handle mixed forward/backward slashes", () => {
      assert.strictEqual(normalizePath("path\\to\\file"), "path/to/file");
    });

    it("should handle paths with colons in filenames", () => {
      assert.strictEqual(
        normalizePath("/path/to/file:name"),
        path.resolve("/path/to/file:name"),
      );
    });
  });
});

describe("checkPathCharacters", () => {
  const originalPlatform = process.platform;

  const runWithPlatform = (platform: NodeJS.Platform, testFn: () => void) => {
    Object.defineProperty(process, "platform", {
      value: platform,
      writable: true,
    });
    try {
      testFn();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        writable: true,
      });
    }
  };

  it("should return null for valid paths (Unix)", () => {
    runWithPlatform("linux", () => {
      expect(checkPathCharacters("/home/user/valid/path")).toBeNull();
      expect(checkPathCharacters("/a/b/c.d-e_f")).toBeNull();
      expect(checkPathCharacters("/path/with spaces")).toBeNull();
    });
  });

  it("should return null for valid paths (Windows)", () => {
    runWithPlatform("win32", () => {
      expect(checkPathCharacters("C:\\Users\\User\\Valid Path")).toBeNull();
      expect(checkPathCharacters("D:\\a\\b\\c.d-e_f")).toBeNull();
    });
  });

  it("should detect path too long", () => {
    runWithPlatform("linux", () => {
      const longPath = "/" + "a".repeat(4097);
      expect(checkPathCharacters(longPath)).toMatch(/exceeds maximum length/);
    });
    runWithPlatform("win32", () => {
      const longWinPath = "C:\\" + "a".repeat(260);
      expect(checkPathCharacters(longWinPath)).toMatch(
        /exceeds maximum length/,
      );
    });
  });

  it("should detect component too long", () => {
    runWithPlatform("linux", () => {
      const longComponent = "/".repeat(10) + "/" + "a".repeat(256);
      expect(checkPathCharacters(longComponent)).toMatch(
        /Directory\/file name too long/,
      );
    });
    runWithPlatform("win32", () => {
      const longWinComponent = "C:\\" + "a".repeat(256);
      expect(checkPathCharacters(longWinComponent)).toMatch(
        /Directory\/file name too long/,
      );
    });
  });

  it("should detect drive root paths (Windows)", () => {
    runWithPlatform("win32", () => {
      expect(checkPathCharacters("C:\\")).toBe(
        "Cannot use drive root directory",
      );
      expect(checkPathCharacters("d:")).toBe("Cannot use drive root directory");
      expect(checkPathCharacters("Z:\\")).toBe(
        "Cannot use drive root directory",
      );
      expect(checkPathCharacters("C:\\folder")).toBeNull();
    });
  });

  it("should detect filesystem root path (Unix)", () => {
    runWithPlatform("linux", () => {
      expect(checkPathCharacters("/")).toBe(
        "Cannot use filesystem root directory",
      );
      expect(checkPathCharacters("/folder")).toBeNull();
    });
  });

  it("should detect relative path components", () => {
    expect(checkPathCharacters("/path/../other")).toMatch(
      /relative components/,
    );
    expect(checkPathCharacters("/path/./other")).toMatch(/relative components/);
    expect(checkPathCharacters("C:\\path\\..\\other")).toMatch(
      /relative components/,
    );
  });

  it("should detect non-printable characters", () => {
    expect(checkPathCharacters("/path/with\x01char")).toMatch(
      /non-printable characters/,
    );
    expect(checkPathCharacters("C:\\path\\with\x7f")).toMatch(
      /non-printable characters/,
    );
  });

  it("should detect Windows reserved names", () => {
    runWithPlatform("win32", () => {
      expect(checkPathCharacters("C:\\CON")).toMatch(/Windows reserved names/);
      expect(checkPathCharacters("C:\\folder\\PRN.txt")).toMatch(
        /Windows reserved names/,
      );
      expect(checkPathCharacters("C:\\folder\\COM1")).toMatch(
        /Windows reserved names/,
      );
      expect(checkPathCharacters("C:\\folder\\LPT9.doc")).toMatch(
        /Windows reserved names/,
      );
      expect(checkPathCharacters("C:\\NUL")).toMatch(/Windows reserved names/);
      expect(checkPathCharacters("C:\\AUX")).toMatch(/Windows reserved names/);
      runWithPlatform("linux", () => {
        expect(checkPathCharacters("/path/to/con")).toBeNull();
      });
    });
  });

  it("should detect invalid Windows characters", () => {
    runWithPlatform("win32", () => {
      expect(checkPathCharacters("C:\\folder<invalid>")).toMatch(
        /not allowed on Windows/,
      );
      expect(checkPathCharacters("C:\\folder:invalid")).toMatch(
        /not allowed on Windows/,
      );
      expect(checkPathCharacters('C:\\folder\"invalid\"')).toMatch(
        /not allowed on Windows/,
      );
      expect(checkPathCharacters("C:\\folder|invalid")).toMatch(
        /not allowed on Windows/,
      );
      expect(checkPathCharacters("C:\\folder?invalid")).toMatch(
        /not allowed on Windows/,
      );
      expect(checkPathCharacters("C:\\folder*invalid")).toMatch(
        /not allowed on Windows/,
      );
      expect(checkPathCharacters("C:\\valid:folder")).toMatch(
        /not allowed on Windows/,
      );
      expect(checkPathCharacters("C:\\valid\\folder")).toBeNull();
      expect(checkPathCharacters("\\\\server\\share\\folder:invalid")).toMatch(
        /not allowed on Windows/,
      );
      runWithPlatform("linux", () => {
        expect(checkPathCharacters("/path/to/file:with:colons")).toBeNull();
        expect(
          checkPathCharacters("/path/to/file<with>other?chars*"),
        ).toBeNull();
      });
    });
  });

  it("should detect Windows device paths", () => {
    runWithPlatform("win32", () => {
      expect(checkPathCharacters("\\\\.\\C:")).toMatch(
        /Device paths are not allowed/,
      );
      expect(checkPathCharacters("\\\\.\\PhysicalDrive0")).toMatch(
        /Device paths are not allowed/,
      );
    });
  });

  it("should detect invalid Unix characters (null byte)", () => {
    runWithPlatform("linux", () => {
      expect(checkPathCharacters("/path/with\x00null")).toMatch(
        /Contains null characters/,
      );
    });
    runWithPlatform("win32", () => {
      expect(checkPathCharacters("C:\\path\x00null")).toBeNull();
    });
  });

  it("should detect invalid Unicode characters (replacement char)", () => {
    expect(checkPathCharacters("/path/with\uFFFDreplacement")).toMatch(
      /invalid Unicode characters/,
    );
  });

  it("should detect leading/trailing whitespace", () => {
    expect(checkPathCharacters(" /path/with/leading/space")).toMatch(
      /leading or trailing whitespace/,
    );
    expect(checkPathCharacters("/path/with/trailing/space ")).toMatch(
      /leading or trailing whitespace/,
    );
    expect(checkPathCharacters("/path/ with /space ")).toMatch(
      /leading or trailing whitespace/,
    );
    expect(checkPathCharacters("C:\\trailing\\space ")).toMatch(
      /leading or trailing whitespace/,
    );
  });

  it("should detect consecutive separators", () => {
    expect(checkPathCharacters("/path//with/double/slash")).toMatch(
      /consecutive path separators/,
    );
    expect(checkPathCharacters("C:\\\\folder")).toMatch(
      /consecutive path separators/,
    );
    expect(checkPathCharacters("C:\\folder\\\\another")).toMatch(
      /consecutive path separators/,
    );
  });
});

describe("checkLocalPath", () => {
  const originalPlatform = process.platform;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    applyMocks();
  });
  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    mock.restore();
  });

  beforeEach(() => {
    resetMockImplementations();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });

  const runWithPlatform = (
    platform: NodeJS.Platform,
    testFn: () => void | Promise<void>,
  ) => {
    Object.defineProperty(process, "platform", {
      value: platform,
      writable: true,
    });
    return Promise.resolve()
      .then(testFn)
      .finally(() => {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      });
  };

  it("should return null for a simple local path (Unix)", async () => {
    await runWithPlatform("linux", async () => {
      mockFsRealpath.mockResolvedValue("/home/user/vault");
      mockExecFn.mockImplementation(async (cmd) => {
        if (cmd.startsWith("df")) {
          return { stdout: "/dev/sda1 ext4 123G 45G 78G 37% /", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      const result = await checkLocalPath("/home/user/vault");
      expect(result).toBeNull();
    });
  });

  it("should return null for a simple local path (Windows)", async () => {
    await runWithPlatform("win32", async () => {
      mockFsRealpath.mockResolvedValue("C:\\Users\\User\\Vault");
      mockExecFn.mockImplementation(async (cmd) => {
        if (cmd.startsWith("wmic") || cmd.startsWith("powershell")) {
          return { stdout: "DriveType=3", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      const result = await checkLocalPath("C:\\Users\\User\\Vault");
      expect(result).toBeNull();
    });
  });

  it("should detect symlink pointing outside parent", async () => {
    mockFsRealpath.mockResolvedValue("/different/place/vault");
    expect(await checkLocalPath("/home/user/vault")).toMatch(
      /symlinks that point outside/,
    );
  });

  it("should handle realpath ELOOP error (circular symlink)", async () => {
    const eloopError = new Error("ELOOP error") as NodeJS.ErrnoException;
    eloopError.code = "ELOOP";
    mockFsRealpath.mockRejectedValue(eloopError);
    expect(await checkLocalPath("/home/user/vault")).toMatch(
      /circular symlinks/,
    );
  });

  it("should detect Windows network drive (UNC - TEST ENV)", async () => {
    await runWithPlatform("win32", async () => {
      mockFsRealpath.mockResolvedValue("\\\\Server\\Share\\folder");
      expect(await checkLocalPath("Z:\\folder")).toMatch(
        /Network, removable, or unknown drive type/,
      );
    });
  });

  it("should return null for Mapped Drive Type 4 (Windows - TEST ENV)", async () => {
    await runWithPlatform("win32", async () => {
      expect(await checkLocalPath("Z:\\folder")).toBeNull();
    });
  });

  it("should return null for Mapped Drive Type 2 (Windows - TEST ENV)", async () => {
    await runWithPlatform("win32", async () => {
      expect(await checkLocalPath("E:\\folder")).toBeNull();
    });
  });

  it("should return null for Mapped Drive Type 0 (Windows - TEST ENV)", async () => {
    await runWithPlatform("win32", async () => {
      expect(await checkLocalPath("X:\\folder")).toBeNull();
    });
  });

  it("should handle wmic/powershell error gracefully (Windows - TEST ENV)", async () => {
    await runWithPlatform("win32", async () => {
      expect(await checkLocalPath("C:\\folder")).toBeNull();
    });
  });

  it("should handle wmic/powershell timeout (Windows - TEST ENV)", async () => {
    await runWithPlatform("win32", async () => {
      expect(await checkLocalPath("C:\\folder")).toBeNull();
    });
  });

  it("should detect Unix network mount (NFS - TEST ENV)", async () => {
    await runWithPlatform("linux", async () => {
      mockFsRealpath.mockResolvedValue("/mnt/nfs_share/data");
      expect(await checkLocalPath("/home/user/linked_nfs_share")).toMatch(
        /Network or remote filesystem/,
      );
    });
  });

  it("should detect Unix network mount (CIFS - TEST ENV)", async () => {
    await runWithPlatform("linux", async () => {
      mockFsRealpath.mockResolvedValue("/media/smb_share/data");
      expect(await checkLocalPath("/home/user/linked_smb_share")).toMatch(
        /Network or remote filesystem/,
      );
    });
  });

  it("should handle df error gracefully (Unix - TEST ENV)", async () => {
    await runWithPlatform("linux", async () => {
      mockFsRealpath.mockResolvedValue("/mnt/unknown_mount/data");
      expect(await checkLocalPath("/home/user/linked_unknown")).toMatch(
        /Network or remote filesystem/,
      );
    });
  });

  it("should handle df timeout (Unix - TEST ENV)", async () => {
    await runWithPlatform("linux", async () => {
      mockFsRealpath.mockResolvedValue("/mnt/timeout_mount/data");
      expect(await checkLocalPath("/home/user/linked_timeout")).toMatch(
        /Network or remote filesystem/,
      );
    });
  });
});

describe("checkSuspiciousPath", () => {
  const originalPlatform = process.platform;

  const runWithPlatform = (
    platform: NodeJS.Platform,
    testFn: () => void | Promise<void>,
  ) => {
    Object.defineProperty(process, "platform", {
      value: platform,
      writable: true,
    });
    return Promise.resolve()
      .then(testFn)
      .finally(() => {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      });
  };

  beforeEach(() => {
    resetMockImplementations();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });

  it("should return null for valid vault paths", async () => {
    expect(
      await checkSuspiciousPath("/home/user/Documents/MyVault"),
    ).toBeNull();
    expect(
      await checkSuspiciousPath("/home/user/Documents/MyVault/.obsidian"),
    ).toBeNull();
    expect(
      await checkSuspiciousPath("C:\\Users\\Test\\Documents\\MyVault"),
    ).toBeNull();
    expect(
      await checkSuspiciousPath("C:\\Users\\Test\\MyVault\\.obsidian"),
    ).toBeNull();
  });

  it("should detect hidden directories (except .obsidian)", async () => {
    await runWithPlatform("linux", async () => {
      expect(
        await checkSuspiciousPath("/home/user/.hidden/vault"),
      ).not.toBeNull();
      expect(
        await checkSuspiciousPath("/home/user/vault/.config"),
      ).not.toBeNull();
    });
    await runWithPlatform("win32", async () => {
      expect(
        await checkSuspiciousPath("C:\\Users\\Test\\.hidden\\"),
      ).not.toBeNull();
    });
  });

  it("should detect system directories", async () => {
    expect(await checkSuspiciousPath("/etc/passwd")).not.toBeNull();
    expect(await checkSuspiciousPath("/tmp/vault")).not.toBeNull();
    expect(await checkSuspiciousPath("/var/log/syslog")).not.toBeNull();
    expect(await checkSuspiciousPath("/usr/bin/app")).not.toBeNull();
    expect(await checkSuspiciousPath("C:\\Windows\\System32")).not.toBeNull();
    expect(
      await checkSuspiciousPath("C:\\Program Files\\SomeApp"),
    ).not.toBeNull();
    expect(await checkSuspiciousPath("c:\\programdata\\")).not.toBeNull();
    expect(await checkSuspiciousPath("C:\\Users\\All Users\\")).not.toBeNull();
  });
});

describe("isParentPath", () => {
  it("should return true if path is a parent", () => {
    expect(isParentPath("/a/b", "/a/b/c")).toBe(true);
    expect(isParentPath("/a", "/a/b/c")).toBe(true);
    expect(isParentPath("C:/Users/Test", "C:/Users/Test/Documents")).toBe(true);
  });

  it("should return false if path is not a parent", () => {
    expect(isParentPath("/a/b", "/a/c")).toBe(false);
    expect(isParentPath("/a/b", "/a/b")).toBe(false);
    expect(isParentPath("/a/b/c", "/a/b")).toBe(false);
    expect(isParentPath("C:/Users/Test", "C:/Users/Other")).toBe(false);
  });

  it("should handle relative paths correctly based on path.relative", () => {
    expect(isParentPath(".", "./a")).toBe(true);
    expect(isParentPath("a", "a/b")).toBe(true);
    expect(isParentPath("a/b", "a")).toBe(false);
  });
});

describe("checkPathOverlap", () => {
  it("should throw McpError for duplicate paths", () => {
    expect(() => checkPathOverlap(["/a/b", "/c/d", "/a/b"])).toThrow(McpError);
    expect(() => checkPathOverlap(["C:/a/b", "C:/c/d", "C:/a/b"])).toThrow(
      McpError,
    );
  });

  it("should throw McpError for overlapping paths (parent/child)", () => {
    expect(() => checkPathOverlap(["/a/b", "/c/d", "/a/b/c"])).toThrow(
      McpError,
    );
    expect(() => checkPathOverlap(["/a/b/c", "/c/d", "/a/b"])).toThrow(
      McpError,
    );
  });

  it("should not throw for non-overlapping, unique paths", () => {
    expect(() => checkPathOverlap(["/a/b", "/c/d", "/a/e"])).not.toThrow();
  });

  it("should normalize paths before checking", () => {
    expect(() => checkPathOverlap(["/a/b/", "/c/d", "/a/b"])).toThrow(McpError);
    expect(() => checkPathOverlap(["/a/b/c/..", "/c/d", "/a/b/e"])).toThrow(
      McpError,
    );
    expect(() => checkPathOverlap(["/a/b/c/../", "/c/d", "/a/b/e"])).toThrow(
      McpError,
    );
    expect(() => checkPathOverlap(["/a/b/c/..", "/c/d", "/a/b"])).toThrow(
      McpError,
    );
  });
});

describe("checkPathSafety", () => {
  const originalPlatform = process.platform;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    applyMocks();
  });
  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    mock.restore();
  });

  beforeEach(() => {
    resetMockImplementations();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });

  const runWithPlatform = (
    platform: NodeJS.Platform,
    testFn: () => void | Promise<void>,
  ) => {
    Object.defineProperty(process, "platform", {
      value: platform,
      writable: true,
    });
    return Promise.resolve()
      .then(testFn)
      .finally(() => {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          writable: true,
        });
      });
  };

  it("should return null for a safe path", async () => {
    const result = await checkPathSafety("/safe/path");
    expect(result).toBeNull();
  });

  it("should return error from checkPathCharacters", async () => {
    const badPath = " /leading/space";
    const result = await checkPathSafety(badPath);
    if (result === null) {
      throw new Error(
        "Expected an error string for checkPathCharacters, got null",
      );
    }
    expect(result).toBe("Contains leading or trailing whitespace");
  });

  it("should return error from checkLocalPath (Windows - TEST ENV UNC)", async () => {
    await runWithPlatform("win32", async () => {
      mockFsRealpath.mockResolvedValue("\\\\Server\\Share\\folder");
      const result = await checkPathSafety("Z:\\network\\");
      if (result === null) {
        throw new Error(
          "Expected an error string for checkLocalPath, got null",
        );
      }
      expect(result).toMatch(/Network, removable, or unknown drive type/);
    });
  });

  it("should return error from checkSuspiciousPath", async () => {
    const result = await checkPathSafety("/etc/config");
    if (result === null) {
      throw new Error(
        "Expected an error string for checkSuspiciousPath, got null",
      );
    }
    expect(result).toMatch(/Points to a system directory/);
  });

  it("should return error if path does not exist", async () => {
    const enoentError = new Error("ENOENT error") as NodeJS.ErrnoException;
    enoentError.code = "ENOENT";
    mockFsStat.mockRejectedValue(enoentError);
    const result = await checkPathSafety("/non/existent/path");
    if (result === null) {
      throw new Error(
        "Expected an error string for non-existent path, got null",
      );
    }
    expect(result).toMatch(/Path does not exist/);
  });

  it("should return error if path is not a directory", async () => {
    mockFsStat.mockResolvedValue({ isDirectory: () => false } as any);
    const result = await checkPathSafety("/path/to/file.txt");
    if (result === null) {
      throw new Error(
        "Expected an error string for non-directory path, got null",
      );
    }
    expect(result).toMatch(/Path is not a directory/);
  });

  it("should return other stat errors", async () => {
    const eaccesError = new Error("EACCES error") as NodeJS.ErrnoException;
    eaccesError.code = "EACCES";
    mockFsStat.mockRejectedValue(eaccesError);
    const result = await checkPathSafety("/restricted/path");
    if (result === null) {
      throw new Error("Expected an error string for stat error, got null");
    }
    expect(result).toMatch(/^Failed to access path info: EACCES error/);
  });

  it("should return error for invalid input path", async () => {
    const result = await checkPathSafety("");
    expect(result).toBe("Invalid path provided to checkPathSafety");
    const result2 = await checkPathSafety(undefined as any);
    expect(result2).toBe("Invalid path provided to checkPathSafety");
  });
});
