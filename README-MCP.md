## 🤖 MCP (Model Context Protocol) Configuration

This repository includes built-in MCP support, allowing AI assistants and MCP-compatible tools to directly access and manage the N8N workflow collection.

### 📋 Prerequisites

- Node.js 18+ installed
- MCP-compatible client (Claude Desktop, Continue.dev, Zed, etc.)
- Repository cloned and dependencies installed (`npm install`)

### 🔧 MCP Client Configuration

#### Claude Desktop

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`  
**Linux**: `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "n8n-workflows": {
      "command": "node",
      "args": ["/absolute/path/to/n8n-workflows/src/mcp-server.js"]
    }
  }
}
```

**Important**: Replace `/absolute/path/to/n8n-workflows` with your actual repository path.

#### Continue.dev (VS Code/JetBrains)

Add to your Continue configuration (`~/.continue/config.json`):

```json
{
  "models": [
    {
      "model": "claude-3-5-sonnet",
      "provider": "anthropic",
      "apiKey": "your-api-key"
    }
  ],
  "mcpServers": {
    "n8n-workflows": {
      "command": "node",
      "args": ["/absolute/path/to/n8n-workflows/src/mcp-server.js"]
    }
  }
}
```

#### Zed Editor

Add to your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "assistant": {
    "version": "2",
    "provider": "anthropic",
    "default_model": "claude-3-5-sonnet",
    "mcp_servers": {
      "n8n-workflows": {
        "command": "node",
        "args": ["/absolute/path/to/n8n-workflows/src/mcp-server.js"]
      }
    }
  }
}
```

#### Cline (VS Code Extension)

1. Install Cline extension in VS Code
2. Open Cline settings (Cmd/Ctrl + Shift + P → "Cline: Open Settings")
3. Add MCP server configuration:

```json
{
  "mcp.servers": {
    "n8n-workflows": {
      "command": "node",
      "args": ["/absolute/path/to/n8n-workflows/src/mcp-server.js"]
    }
  }
}
```

#### Custom MCP Client Implementation

For custom MCP client implementations, connect to the server via stdio:

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

// Spawn the MCP server
const serverProcess = spawn('node', ['/path/to/n8n-workflows/src/mcp-server.js']);

// Create transport and client
const transport = new StdioClientTransport({
  command: 'node',
  args: ['/path/to/n8n-workflows/src/mcp-server.js']
});

const client = new Client({
  name: 'n8n-workflows-client',
  version: '1.0.0'
}, {
  capabilities: {}
});

// Connect and use
await client.connect(transport);

// List available tools
const tools = await client.request({ method: 'tools/list' });

// Call a tool
const result = await client.request({
  method: 'tools/call',
  params: {
    name: 'search_workflows',
    arguments: {
      query: 'telegram',
      category: 'messaging'
    }
  }
});
```

### 🐳 Docker Configuration

If running the N8N workflows system in Docker:

```dockerfile
# Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 8000
CMD ["node", "src/mcp-server.js"]
```

Docker Compose with MCP:

```yaml
version: '3.8'
services:
  n8n-workflows-mcp:
    build: .
    volumes:
      - ./database:/app/database
      - ./workflows:/app/workflows
    command: node src/mcp-server.js
```

For Claude Desktop with Docker:

```json
{
  "mcpServers": {
    "n8n-workflows": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "/path/to/database:/app/database", "n8n-workflows-mcp"]
    }
  }
}
```

### 🌐 Remote MCP Access

For remote MCP server access (advanced users):

1. **SSH Tunnel Method**:
```json
{
  "mcpServers": {
    "n8n-workflows": {
      "command": "ssh",
      "args": [
        "user@remote-server",
        "cd /path/to/n8n-workflows && node src/mcp-server.js"
      ]
    }
  }
}
```

2. **MCP Proxy Server** (requires additional setup):
```javascript
// proxy-server.js
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  const mcp = spawn('node', ['src/mcp-server.js']);
  
  mcp.stdout.on('data', (data) => ws.send(data));
  ws.on('message', (data) => mcp.stdin.write(data));
  ws.on('close', () => mcp.kill());
});
```

### 🔍 Verifying MCP Connection

To verify your MCP setup is working:

1. **Check server is accessible**:
```bash
# This should run without errors
node /path/to/n8n-workflows/src/mcp-server.js
```

2. **Test with direct command**:
```bash
# Send a test request
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node /path/to/n8n-workflows/src/mcp-server.js
```

3. **In your MCP client**, try these test queries:
   - "List available tools"
   - "Search for telegram workflows"
   - "Show workflow statistics"

### 🛠️ Troubleshooting

#### Common Issues

1. **"MCP server not found"**
   - Verify the absolute path in your configuration
   - Ensure `src/mcp-server.js` exists
   - Check file permissions

2. **"Connection refused"**
   - Restart your MCP client after configuration changes
   - Check if Node.js is in PATH: `which node`
   - Try using full Node.js path: `/usr/local/bin/node`

3. **"Database not found"**
   - Ensure you've run initial setup: `npm run init`
   - Check database exists: `ls database/workflows.db`
   - Run indexing: `npm run index`

4. **Permission errors**
   - Ensure read permissions on database and workflow files
   - Check execute permissions: `chmod +x src/mcp-server.js`

#### Debug Mode

Enable detailed logging by setting environment variables:

```json
{
  "mcpServers": {
    "n8n-workflows": {
      "command": "node",
      "args": ["/path/to/n8n-workflows/src/mcp-server.js"],
      "env": {
        "DEBUG": "mcp:*",
        "NODE_ENV": "development"
      }
    }
  }
}
```

### 📚 MCP Tools Reference

The MCP server exposes 13 tools for workflow management:

| Tool | Description |
|------|-------------|
| `search_workflows` | Search with filters, categories, and full-text search |
| `get_workflow` | Get complete workflow details and JSON |
| `get_statistics` | View analytics and metrics |
| `get_categories` | List workflow categories |
| `get_integrations` | Show all 365 integrations |
| `analyze_workflow` | Analyze workflow structure |
| `generate_diagram` | Create Mermaid diagrams |
| `export_workflow` | Export with options |
| `bulk_analyze` | Pattern analysis |
| `find_similar` | Find similar workflows |
| `create_workflow_template` | Generate templates |
| `validate_workflow` | Validate JSON structure |
| `get_workflow_recommendations` | AI-powered suggestions |

### 🔗 Additional Resources

- [MCP Specification](https://modelcontextprotocol.io/docs)
- [Claude Desktop Docs](https://claude.ai/docs/desktop)
- [Continue.dev MCP Guide](https://continue.dev/docs/mcp)
- [Custom MCP Client Tutorial](https://modelcontextprotocol.io/docs/clients)

---