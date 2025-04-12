# Obsidian MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that enables AI assistants to interact with Obsidian vaults, providing tools for reading, creating, editing and managing notes and tags.

## Warning!!!

This MCP has read and write access (if you allow it). Please. PLEASE backup your Obsidian vault prior to using obsidian-mcp to manage your notes. I recommend using git, but any backup method will work. These tools have been tested, but not thoroughly, and this MCP is in active development.

## Features

- Read and create notes in your vault
- Edit existing notes (append, prepend, replace content while preserving frontmatter)
- Move notes
- Manage frontmatter (add aliases, manage tags)
- Update links automatically when notes are moved
- List non-Markdown files (images, PDFs, etc.)
- Search vault contents with basic operators (`path:`, `file:`)
- Configurable vault access

## Requirements

- Node.js 20 or higher
- [Bun](https://bun.sh/) (for development and testing)
- An Obsidian vault

## Installation

The server can be run directly using `node` or via `npx`. The primary way to use this is often via an MCP client like Claude Desktop.

**Key Change:** Unlike previous versions that took vault paths as command-line arguments, the server now expects vault configurations via a separate mechanism (usually determined by the client or environment setup). When run directly, it currently **does not accept vault paths as arguments**. The client invoking the server is responsible for providing the vault context for each tool request.

### Example: Running Directly (for testing/development)

You would typically integrate this server into a larger application or use a client that manages the server process. For direct testing:

1.  Build the server: `bun run build`
2.  Run the server (it will listen on stdio): `bun build/main.js`
3.  Send JSON-RPC requests to its stdin.

### Example: Claude Desktop Configuration

Claude Desktop manages the server process and provides the vault context. Configuration is slightly different now:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

```json
{
    "mcpServers": {
        "obsidian": {
            // Command to run the server (use npx or direct path after building)
            "command": "npx", // Or "node",
            "args": [
                // If using npx:
                "-y", "obsidian-mcp"
                // If using node after building:
                // "<absolute-path-to-obsidian-mcp>/build/main.js"
            ],
            // IMPORTANT: Vaults are no longer passed as arguments here.
            // Claude Desktop needs to be updated or configured to provide
            // the vault context per-request, potentially via UI selection
            // or automatically based on the active window. This server
            // relies on the `vault` argument within each tool call.
             "config": {
                 // Example (Syntax may vary based on Claude Desktop version):
                 // Define the vaults Claude Desktop knows about and can offer
                 // to the server via the `vault` argument in tool calls.
                 "availableVaults": [
                    { "name": "personal", "path": "/Users/username/Documents/PersonalVault" },
                    { "name": "work", "path": "/Users/username/Documents/WorkVault" }
                 ]
            }
        }
    }
}
```

**Note:** The exact configuration for `availableVaults` or how Claude Desktop sends the `vault` argument might differ based on its implementation. Refer to the client's documentation.

Restart the client after saving the configuration.

If you have connection issues, check the client's logs:
- MacOS: `~/Library/Logs/Claude/mcp*.log`
- Windows: `%APPDATA%\\Claude\\logs\\mcp*.log`

## Development

```bash
# Clone the repository
git clone https://github.com/StevenStavrakis/obsidian-mcp
cd obsidian-mcp

# Install dependencies using Bun
bun install

# Build
bun run build

# Run tests (Unit & E2E)
bun test
```

To run the server locally for development, pointing it to specific vaults requires modifying the startup script (`src/main.ts` or a custom script) to instantiate `ObsidianServer` with the desired vault configurations, similar to how it's done in the E2E tests (`e2e/crud.test.ts`).

## Available Tools

The server exposes tools via the Model Context Protocol. The exact list can be retrieved using an MCP client, but key tools include:

-   `read-note`: Read the contents of a note.
-   `create-note`: Create a new note.
-   `edit-note`: Edit an existing note (supports `append`, `prepend`, `replace` operations).
-   `move-note`: Move/rename a note, updating incoming links.
-   `add-alias`: Add an alias to a note's frontmatter.
-   `add-tags`: Add tags to a note's frontmatter.
-   `list-files`: List non-Markdown files in the vault or a sub-directory.
-   `search-vault`: Search notes (supports `path:`, `file:` operators).
-   _(Potentially others like remove-tags, etc.)_

**Tool Usage:** All tools that operate on files (`read-note`, `edit-note`, `create-note`, `move-note`, `add-alias`, `add-tags`, `list-files`, `search-vault` with `path:`) require a `vault` argument specifying the **name** of the target vault (which must be known to the client and correspond to a vault the server is implicitly configured for by the client environment). They also require a `path` argument relative to the vault root.

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
