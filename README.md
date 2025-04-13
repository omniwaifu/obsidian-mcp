# Obsidian MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that enables AI assistants to interact with Obsidian vaults, providing tools for reading, creating, editing and managing notes and tags.

## Warning!!!

This MCP has read and write access (if you allow it). Please. PLEASE backup your Obsidian vault prior to using obsidian-mcp to manage your notes. I recommend using git, but any backup method will work. These tools have been tested, but not thoroughly, and this MCP is in active development.

## Features

- Read and create notes in your vault
- Edit existing notes (append, prepend, replace content while preserving frontmatter)
- Move notes
- Manage frontmatter (add/remove/list aliases, add/remove/rename tags)
- Create directories and list directory contents
- Delete notes
- Update links automatically when notes are moved
- List non-Markdown files (images, PDFs, etc.)
- Search vault contents with basic operators (`path:`, `file:`)
- Find backlinks to notes
- List bookmarks from the core Bookmarks plugin
- Get the path for today's daily note
    - Path is cached, so if you change your path to daily notes, you might need to wait a bit for the cache to update.
- List and toggle basic Markdown tasks in notes
- Configurable vault access

## Requirements

- Node.js 20 or higher
- [Bun](https://bun.sh/) (for development and testing)
- An Obsidian vault

## Installation

This server is intended to be run locally and integrated with an MCP client (like Claude Desktop).

**Recommended Method:** Run the server directly using `node` after building it.

1.  Clone your fork and navigate into the directory.
2.  Install dependencies: `bun install`
3.  Build the server: `bun run build`
4.  Configure your MCP client to execute the server using `node` and the **absolute path** to the generated `build/main.js` script in your local project directory.

### Example: Running Directly (for debugging)

To run the server directly in your terminal (e.g., for debugging the server itself):

```bash
# Build first if you haven't
bun run build

# Run using node
node <absolute-path-to-your-project>/build/main.js

# Or using bun
bun <absolute-path-to-your-project>/build/main.js
```
The server will start, potentially use a default vault configuration if defined in `src/main.ts`, and listen for JSON-RPC messages on standard input/output.

### Example: Claude Desktop Configuration (Using Local Build)

Configure Claude Desktop (or a similar client) to run your specific build:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

```json
{
    "mcpServers": {
        "obsidian": {
            "command": "node",
            "args": [
                "/path/to/your/fork/obsidian-mcp/build/main.js"
            ],
             "config": {
                 "availableVaults": [
                    { "name": "minerva", "path": "/path/to/your/minerva/vault" },
                    { "name": "personal", "path": "/path/to/your/personal/vault" }
                 ]
            }
        }
    }
}
```

**Note:** The exact configuration for `availableVaults` and how the client uses it depends on the client's implementation. The server expects the `vault` name (e.g., `"minerva"`) within the arguments of each tool call.

Restart the client after saving the configuration.

If you have connection issues, check the client's logs:
- MacOS: `~/Library/Logs/Claude/mcp*.log`
- Windows: `%APPDATA%\\Claude\\logs\\mcp*.log`

## Development

```bash
# Clone your fork
git clone <your-fork-url>
cd obsidian-mcp # Or your fork's directory name

# Install dependencies using Bun
bun install

# Build
bun run build

# Run tests (Unit & E2E)
bun test
```

To run the server locally during development, use `node build/main.js` or `bun build/main.js`. If you need to test specific vault configurations without relying on the client, you can temporarily modify the default configuration logic in `src/main.ts` or pass vault paths as command-line arguments (which will override the default behavior).

## Available Tools

The server exposes tools via the Model Context Protocol. The exact list can be retrieved using an MCP client, but key tools include:

-   `read-note`: Read the contents of a note.
-   `create-note`: Create a new note.
-   `edit-note`: Edit an existing note (supports `append`, `prepend`, `replace` operations).
-   `move-note`: Move/rename a note, updating incoming links.
-   `create-directory`: Create a new directory.
-   `list-directory`: List files and directories in a vault path.
-   `delete-note`: Delete a note.
-   `add-alias`: Add an alias to a note's frontmatter.
-   `remove-alias`: Remove an alias from a note's frontmatter.
-   `list-aliases`: List all aliases for a note.
-   `add-tags`: Add tags to a note's frontmatter.
-   `remove-tags`: Remove tags from a note's frontmatter.
-   `rename-tag`: Rename a tag across the entire vault.
-   `list-files`: List non-Markdown files in the vault or a sub-directory.
-   `search-vault`: Search notes (supports `path:`, `file:` operators).
-   `get-backlinks`: Find notes linking to a target note.
-   `list-bookmarks`: List items from the Bookmarks core plugin.
-   `get-daily-note-path`: Calculate the expected path for today's daily note.
-   `get-tasks-in-note`: List basic Markdown tasks (`- [ ]`/`- [x]`) in a note.
-   `toggle-task`: Toggle the completion status of a task on a specific line.
-   _(Potentially others like remove-tags, etc.)_

**Tool Usage:** All tools that operate on files (`read-note`, `edit-note`, `create-note`, `move-note`, `add-alias`, `add-tags`, `list-files`, `search-vault` with `path:`, `list-directory`, `get-backlinks`, `get-tasks-in-note`, `toggle-task`) require a `vault` argument specifying the **name** of the target vault (which must be known to the client and correspond to a vault the server is implicitly configured for by the client environment). They also require a `path` argument relative to the vault root (where applicable, e.g., not for `list-bookmarks` or `get-daily-note-path` which only need the vault).

Example `read-note` arguments:
`{ "vault": "work", "path": "projects/alpha/meeting-notes.md" }`

## Testing

Unit tests and End-to-End (E2E) tests are implemented using `bun:test`.

-   **Unit Tests:** Located within `src/` alongside the code they test (e.g., `src/utils/path.test.ts`).
-   **E2E Tests:** Located in the `e2e/` directory (e.g., `e2e/crud.test.ts`). These tests create a temporary vault, instantiate the server, register tools, and simulate MCP client calls to verify tool interactions with the filesystem.

Run all tests:
```bash
bun test
```

Run only E2E tests:
```bash
bun test e2e/
```

### Test Queries

```md
    1. What is the path for today's daily note in the "my_vault" vault?
    2. Create that daily note if it doesn't exist, with the title "# Today's Tasks and Notes" and add the following tasks under it:
    - [ ] Plan weekend activities
    - [ ] Read chapter 3 of 'Project X'
    - [ ] Call Mom
    3. List the tasks currently in today's daily note.
    4. Mark the 'Call Mom' task as complete.
    5. List the tasks again to confirm the change.
    6. Create a new note in the root called "Test Backlink Note.md" with the content "This note links to [[Today's daily note path]]". (Replace 'Today's daily note path' with the actual path obtained in step 1).
    7. Find all backlinks for today's daily note.
    8. List the contents of the root directory.
    9. List my bookmarks.
```

## Security

This server requires access to your Obsidian vault directory. Access is typically granted by the client application (like Claude Desktop) based on its configuration.

-   The server performs path safety checks to prevent tools from accessing files outside the specified vault directory for a given operation.
-   Rate limiting and message size validation are implemented.
-   Always review tool actions requested by an AI assistant before approving them.

## Troubleshooting

Common issues:

1.  **Server connection errors in Client (e.g., Claude Desktop)**
    *   Verify the client's MCP server configuration (`command`, `args`).
    *   Ensure the client is correctly configured to provide the `vault` name in tool arguments if required.
    *   Check client logs.

2.  **Tool errors ("Vault not found", "Path validation failed", etc.)**
    *   Ensure the `vault` name sent in the tool arguments matches a vault known/configured in the client environment.
    *   Ensure the `path` argument is relative and correct.
    *   Check server logs if running directly, or client logs.

3.  **Permission errors**
    *   Ensure the user running the client (and thus the server process) has read/write permissions for the configured vault directories.

## License

MIT
