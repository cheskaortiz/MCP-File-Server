# MCP File Server

**Agentic AI II — Midterm Project**

A sandboxed MCP (Model Context Protocol) file server built with TypeScript. It allows compatible AI clients to read, search, create, update, and delete files within a designated workspace through MCP tools.

The project supports two transports:

- **stdio:** For MCP clients that launch the server as a local process.
- **Streamable HTTP:** For HTTP-based clients, including remote Claude Desktop connectors using OAuth.

Security features include workspace sandboxing, input validation, authentication, audit logging, file-version checks, and handoff-file protection.

## Milestone Status

| Milestone | Status |
|---|---|
| M1 — Skeleton | Verified locally |
| M2 — Sandbox and Core Tools | Previously verified: 129 tests passed across 11 files; typecheck and build passed |
| M3 — HTTP Transport and Authentication | HTTP checks, PM2, ngrok, HTTP Inspector, and Claude Desktop connection tested locally |
| M4 — Handoff Files and Protocol | Handoff-file protection implemented; automated cross-session handoff test passed |
| M5 — Multi-Session Demonstration | Final demonstration pending |

These statuses reflect recorded development results. Run the current tests before submission to confirm the final state.

## Prerequisites

- Node.js 20.12 or later
- npm
- Git
- Claude Desktop or another compatible MCP client for manual testing
- ngrok for remote connection testing
- PM2 (optional) for process management

Check your installed versions:

```powershell
node -v
npm -v
git --version
```

## Installation and Setup

### 1. Obtain the Repository

Clone the repository using its actual URL:

```powershell
git clone <YOUR_REPOSITORY_URL>
cd mcp-file-server
```

Replace `<YOUR_REPOSITORY_URL>` with the repository URL. If you already have the project, open its folder and skip the clone command.

### 2. Install Dependencies

From the project root, run:

```powershell
npm.cmd install
```

### 3. Configure the Environment

Create a local `.env` file from the example:

```powershell
Copy-Item .env.example .env
```

If `.env` already exists, do not overwrite it. Review its current settings instead.

Keep `.env` private. Never commit real tokens, passwords, or OAuth credentials to Git.

### 4. Verify the Installation

Run the typecheck, test suite, and production build:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Use `npm.cmd` in Windows PowerShell if the execution policy blocks `npm.ps1`.

## Workspace Configuration

The workspace is the local directory that the MCP tools are allowed to access, subject to the server's security rules. Its location is determined by `WORKSPACE_ROOT` in `.env`.

The default is `./workspace`, relative to the application's configured working directory.

### Use the Repository Workspace

```dotenv
WORKSPACE_ROOT=./workspace
```

This uses the `workspace/` directory included in the repository, which contains sample files for demonstrations.

Example:

```text
mcp-file-server/
├── src/
├── tests/
└── workspace/
    ├── .gitkeep
    └── sample-projects/
        ├── README.md
        └── index.js
```

### Use a Separate Local Workspace

You can use a separate folder for assignments, notes, and other test files without mixing them with the source code.

For example:

```text
Desktop/
├── mcp-file-server/
│   └── workspace/
│       └── sample-projects/
└── mcp-test-workspace/
    ├── assignment.txt
    ├── lecture-notes.txt
    └── PROJECT_STATE.md
```

Set `WORKSPACE_ROOT` to the actual path:

```dotenv
WORKSPACE_ROOT=C:/Users/your-username/Desktop/mcp-test-workspace
```

Replace `your-username` with the appropriate Windows account name, and make sure the directory exists.

**Important:** Only the directory configured by `WORKSPACE_ROOT` is used as the active workspace. If you change it, restart the server and verify the result with `list_files`.

Use a dedicated workspace instead of granting access to your entire user directory or system directory.

## Environment Variables

Configure the variables required by the selected server mode.

| Variable | Default | Purpose |
|---|---|---|
| `WORKSPACE_ROOT` | `./workspace` | Directory accessible through MCP tools |
| `AUDIT_LOG_PATH` | `./logs/audit.log` | Audit log for mutating operations; keep outside the workspace |
| `MCP_HOST` | `127.0.0.1` | HTTP server bind address |
| `MCP_PORT` | `3000` | HTTP server port |
| `MCP_ALLOWED_HOSTS` | Empty | Optional comma-separated allow-list of HTTP Host values |
| `MCP_AUTH_MODE` | `static` | Authentication mode: `static`, `oauth`, or `both` |
| `MCP_AUTH_TOKEN` | None | Required in `static` and `both` modes |
| `MCP_OAUTH_ISSUER_URL` | None | Public HTTPS issuer origin; required for OAuth modes |
| `MCP_OAUTH_RESOURCE_URL` | None | Public HTTPS MCP resource URL; required for OAuth modes |
| `MCP_OAUTH_OWNER_PASSWORD` | None | OAuth consent password of at least 32 characters |
| `MCP_OAUTH_STORAGE_DIR` | None | Absolute persistent directory outside `WORKSPACE_ROOT` |

### Authentication Modes

- **`static`** — uses a configured bearer token.
- **`oauth`** — uses the OAuth flow and does not require `MCP_AUTH_TOKEN`.
- **`both`** — accepts OAuth access tokens or the configured static token.

Generate a token for static or combined authentication:

```powershell
npm.cmd run gen-token
```

Copy the generated value into `MCP_AUTH_TOKEN` in `.env`. The token must be at least 32 characters long.

`MCP_ALLOWED_HOSTS` accepts host names, not complete URLs. Do not include `https://` or `/mcp`.

## Running the Server

Choose the transport that matches your MCP client.

### Option A: Standard MCP Server (stdio)

Use stdio when a compatible client launches the server as a local process.

```powershell
npm.cmd run build
npm.cmd start
```

This starts the standard entry point, `dist/server.js`. Configure the local client to launch this server according to the client's instructions.

### Option B: HTTP Server

The HTTP server exposes:

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Health endpoint: `http://127.0.0.1:3000/healthz`

These addresses assume `MCP_HOST=127.0.0.1` and `MCP_PORT=3000`.

#### 1. Configure Static Authentication

For local HTTP testing, the relevant `.env` settings can be:

```dotenv
MCP_HOST=127.0.0.1
MCP_PORT=3000
MCP_AUTH_MODE=static
MCP_AUTH_TOKEN=<YOUR_GENERATED_TOKEN>
MCP_ALLOWED_HOSTS=
```

Replace the token placeholder with the generated token. Keep only one entry for each environment variable.

#### 2. Start in Development Mode

```powershell
npm.cmd run dev:http
```

#### 3. Start in Production Mode

Stop the development server first, then run:

```powershell
npm.cmd run build
npm.cmd run start:http
```

This starts the compiled HTTP server, `dist/httpServer.js`, in the foreground.

Keep the server terminal open while testing.

#### 4. Test the Health Endpoint

Open another PowerShell terminal and run:

```powershell
curl.exe -i http://127.0.0.1:3000/healthz
```

A successful response returns HTTP `200 OK` and:

```json
{"status":"ok"}
```

The health check confirms that the HTTP service responds. It does not prove that authentication or MCP tool calls work.

In static authentication mode, HTTP requests to `/mcp` require:

```http
Authorization: Bearer <YOUR_GENERATED_TOKEN>
```

Clients must also support the MCP Streamable HTTP protocol.

## Connecting Claude Desktop Through Remote OAuth

For a remote Claude Desktop connector, the HTTP server must be reachable through a public HTTPS URL. A temporary ngrok tunnel can be used for testing and demonstrations.

### 1. Obtain a Public HTTPS Hostname

Open a separate PowerShell terminal and run:

```powershell
ngrok http 3000
```

Copy the public HTTPS hostname displayed by ngrok. The forwarding destination should be `http://localhost:3000`.

If the tunnel starts before the HTTP server, requests may temporarily return `502 Bad Gateway`. This is expected until the local server is running.

Keep the tunnel terminal open.

### 2. Configure OAuth

In `.env`, configure the OAuth variables using the actual public hostname:

```dotenv
MCP_HOST=127.0.0.1
MCP_PORT=3000
MCP_AUTH_MODE=oauth
MCP_OAUTH_ISSUER_URL=https://your-public-host.example
MCP_OAUTH_RESOURCE_URL=https://your-public-host.example/mcp
MCP_OAUTH_OWNER_PASSWORD=<YOUR_LONG_RANDOM_PASSWORD>
MCP_OAUTH_STORAGE_DIR=C:/Users/your-username/AppData/Local/mcp-file-server/oauth-state
MCP_ALLOWED_HOSTS=your-public-host.example
```

Replace every placeholder with the appropriate value.

- `MCP_OAUTH_ISSUER_URL` must be the public HTTPS origin without `/mcp`.
- `MCP_OAUTH_RESOURCE_URL` must identify the public MCP endpoint, normally ending in `/mcp`.
- The owner password must contain at least 32 characters.
- The OAuth storage directory must be an absolute path outside the workspace.
- The allowed host must match the public hostname.

The public hostname must remain consistent across these settings. If it changes, update `.env` and restart the server before reconnecting.

Do not share real credentials or commit the OAuth storage directory to Git.

### 3. Start the HTTP Server

From the project root:

```powershell
npm.cmd run build
npm.cmd run start:http
```

Keep the HTTP server and ngrok terminals open.

### 4. Check Public Connectivity

In another terminal, run:

```powershell
curl.exe -i https://your-public-host.example/healthz
```

Replace the placeholder with the actual public hostname.

A successful response returns HTTP `200 OK` and `{"status":"ok"}`. This verifies reachability, not the complete OAuth flow.

### 5. Add the Connector in Claude Desktop

1. Open Claude Desktop.
2. Go to **Settings → Connectors**.
3. Select the option to add a custom connector.
4. Enter a name, such as `MCP File Server`.
5. Enter the public HTTPS MCP URL ending in `/mcp`.
6. Complete the OAuth authorization flow.
7. Follow the consent page instructions and provide the configured owner password when requested.
8. Enable the connector for your chat and test an MCP tool.

The available interface and connector options may vary by Claude account and version. Follow the remote custom connector workflow rather than adding the remote URL directly to `claude_desktop_config.json`.

### Testing on Another Computer

A tester who clones the repository must configure their own `.env` file using `.env.example` as a reference, choose a workspace, configure authentication, and start the server.

For remote Claude Desktop testing, the server must be reachable through an accessible public HTTPS endpoint. The public hostname must match the OAuth configuration and allowed-host settings.

Your local `.env`, OAuth credentials, and active ngrok tunnel are not included when the repository is cloned. The tester must configure their own environment and run their own server and tunnel, unless you specifically arrange access to a separately maintained demo endpoint.

## Using PM2 (Optional)

PM2 can manage the HTTP server process without requiring the server to remain attached to a foreground terminal.

Install PM2 if necessary:

```powershell
npm.cmd install --global pm2
```

Build the project and start the HTTP server from the project root:

```powershell
npm.cmd run build
pm2.cmd start dist/httpServer.js --name mcp-file-server
```

Check the process:

```powershell
pm2.cmd status
```

The process should show `online`.

View recent logs:

```powershell
pm2.cmd logs mcp-file-server --lines 50
```

Restart or stop the process:

```powershell
pm2.cmd restart mcp-file-server
pm2.cmd stop mcp-file-server
```

Use either the foreground server or the PM2-managed server for a given port, not both simultaneously.

## Testing the Project

Run these commands from the repository root:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

To run the HTTP-specific tests:

```powershell
npm.cmd test -- tests/http.test.ts
```

To launch MCP Inspector with the standard stdio server:

```powershell
npm.cmd run build
npm.cmd run inspect
```

For HTTP testing, open MCP Inspector separately and connect it to the running `/mcp` endpoint using the authentication method configured for that server.

### Manual Claude Desktop Test

First, place a small test file in the configured workspace.

Ask Claude:

> Use the MCP File Server's `list_files` tool to list the files in the workspace root. Do not create, edit, or delete any files.

Then test reading:

> Use the MCP File Server's `read_file` tool to read `assignment.txt` from the workspace root. Summarize the contents without modifying the file.

Replace `assignment.txt` with a file that actually exists in the workspace.

For write tests, use a disposable test file and verify its contents on disk. Do not start with destructive operations against important files.

## Available MCP Tools

The server exposes nine tools.

| Tool | Purpose |
|---|---|
| `list_files` | Lists workspace files and directories |
| `read_file` | Reads supported text files and returns a SHA-256 version |
| `write_file` | Creates or updates files |
| `str_replace` | Replaces an exact text match |
| `delete_file` | Deletes permitted files after confirmation |
| `search_files` | Searches for files using a glob-style pattern |
| `search_code` | Searches supported text-file contents |
| `repo_map` | Displays the workspace tree and file counts |
| `git_status` | Checks Git status when the workspace is a Git repository |

All tool inputs are validated using Zod schemas.

### Important File-Format Note

The current `read_file` tool supports text-file reading up to 1 MiB. Examples of text files include `.txt`, `.md`, `.js`, `.ts`, and `.json`.

PDF text extraction is not documented as a supported feature in this implementation. A PDF can be stored in the workspace, but the current tools should not be described as PDF readers unless that capability is implemented and tested.

## Multi-Session Handoff

The project supports file-based handoff using `PROJECT_STATE.md`.

A session can save the relevant project context and next task in this file. A separate client session can read the same file and continue the work, provided that both sessions use the same workspace.

Example prompt:

> Read `PROJECT_STATE.md` using the MCP File Server. Summarize the current project state and identify the next task. Do not modify any files.

This is file-based handoff, not automatic sharing of conversation history. The automated HTTP tests include a cross-session handoff test; the final milestone demonstration remains a separate verification activity.

## Sandbox and Security

The server applies security checks to client-provided file paths and file operations.

Implemented protections include:

- Normalizing paths and restricting access to the configured workspace.
- Rejecting absolute paths, Windows drive paths, UNC paths, and null bytes.
- Checking symbolic links against the real workspace root.
- Avoiding symlink traversal during directory listing.
- Protecting the workspace root, `.git` contents, and designated handoff files from prohibited modifications.
- Validating tool inputs with Zod.
- Using audit logging for mutating operations.
- Returning concise client-facing errors without exposing stack traces or host filesystem paths.

Additional precautions:

- Keep `.env`, authentication secrets, and OAuth state out of Git.
- Keep audit logs and OAuth storage outside the workspace.
- Use a dedicated workspace containing only the files needed for the task.
- Review tool requests before allowing write or delete operations.
- Keep authentication enabled for remote connections.
- Remember that an HTTPS tunnel provides connectivity, not automatic security.

These protections reduce risk but do not eliminate every possible filesystem or deployment threat.

## Concurrency and Version Checks

`read_file` returns a SHA-256 file version. Passing that value through `if_version` allows `write_file`, `str_replace`, and `delete_file` to detect certain changes made since the file was read.

The server uses per-file locking within a single process for version-checked mutations. These locks do not coordinate with external editors or other processes that modify the same files directly.

## Troubleshooting

**The server does not start**

Check the terminal output, `.env` settings, and whether another process is using the configured port.

**ngrok returns `502 Bad Gateway`**

Confirm that the local server is running and that the tunnel points to the configured port. If `MCP_PORT=3000`, use `ngrok http 3000`.

**ngrok reports that the endpoint is already online**

Stop the existing tunnel with `Ctrl+C` in its terminal before starting another tunnel with the same endpoint.

**`403 Forbidden host`**

Check `MCP_ALLOWED_HOSTS` against the hostname used by the request. The allow-list contains host names, not full URLs. Restart the server after changing `.env`.

**Claude Desktop cannot connect**

Confirm that the server and tunnel are running, the connector URL ends in `/mcp`, and the OAuth URLs match the public hostname.

**Claude can list files but cannot read one**

Check that the file exists within the configured workspace, that its exact filename is correct, and that it is a supported text file within the size limit.

**The wrong files appear**

Check `WORKSPACE_ROOT` and restart the server after changing it. Use `list_files` to verify the active workspace.

**The health check works but MCP tools fail**

The health endpoint verifies HTTP availability only. Use the MCP Inspector or connected client to test initialization, tool listing, and actual tool calls.

## Known Limitations

- The server has not been deployed to permanent public hosting; remote demonstrations have used a temporary ngrok tunnel.
- Remote access depends on the local server and tunnel remaining active.
- PDF text extraction is not documented as implemented.
- Version checks and locks do not coordinate with external editors or processes.
- Some unusual Windows filesystem behaviors may not be fully covered.
- The custom glob implementation does not support every glob syntax, including braces and character classes.
- stdio and HTTP transports have different connection and authentication requirements.
- The final M5 multi-session demonstration remains pending.

## Project Structure

```text
mcp-file-server/
├── dist/                 Compiled JavaScript output
├── logs/                 Local application logs
├── node_modules/         Installed project dependencies
├── src/
│   ├── config/           Environment and HTTP configuration
│   ├── http/             HTTP application and authentication handling
│   ├── oauth/            OAuth provider and token storage
│   ├── security/         Workspace sandbox and file mutation policies
│   ├── tools/            Implementations of the 9 MCP tools
│   ├── utils/            Shared filesystem and logging utilities
│   ├── createServer.ts   Shared MCP server initialization
│   ├── httpServer.ts     HTTP transport entry point
│   └── server.ts         Standard input/output (stdio) entry point
├── tests/                Automated tests for project functionality
├── workspace/            Default sandbox workspace
│   └── sample-project/   Sample files for testing file operations
│       ├── index.js      Sample JavaScript source file
│       ├── README.md     Sample project documentation
│       └── .gitkeep      Placeholder for Git tracking
├── .env                  Local environment variables
├── .env.example          Example environment configuration
├── .gitignore            Files excluded from Git tracking
├── ecosystem.config.cjs  PM2 process management configuration
├── package-lock.json     Locked dependency versions
├── package.json          Project metadata, dependencies, and scripts
├── README.md             Setup instructions and project documentation
└── tsconfig.json         TypeScript compiler configuration
```

## References

- [Model Context Protocol Documentation](https://modelcontextprotocol.io/docs/getting-started/intro)
- [MCP TypeScript SDK Documentation](https://ts.sdk.modelcontextprotocol.io/)
- [Anthropic: Getting Started with Custom Connectors Using Remote MCP](https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp)
- [Anthropic: Building Custom Connectors via Remote MCP Servers](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers)

---

## Project Status

The MCP File Server has implemented the core file tools, sandboxing, HTTP transport, authentication, and basic handoff functionality. Recorded tests and local demonstrations have verified the development workflow and a remote Claude Desktop connection.

The remaining milestone work is the final M5 multi-session demonstration. Update this README whenever implementation, test results, configuration, or milestone status changes.