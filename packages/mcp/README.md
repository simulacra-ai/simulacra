# Simulacra MCP Bridge

The MCP (Model Context Protocol) bridge connects Simulacra to MCP tool servers and exposes their tools as Simulacra tool classes, so the model can use them without writing custom tool implementations.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/mcp @modelcontextprotocol/sdk
```

## Usage

```typescript
import { Conversation, WorkflowManager } from "@simulacra-ai/core";
import { McpToolProvider } from "@simulacra-ai/mcp";

// connect to an MCP server
const mcp = new McpToolProvider({
  servers: [
    {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  ],
});
await mcp.connect();

// add MCP tools to the conversation's toolkit
using conversation = new Conversation(provider);
conversation.toolkit = [...conversation.toolkit, ...mcp.getToolClasses()];
using manager = new WorkflowManager(conversation);

await conversation.prompt("List the files in /tmp");

// disconnect when done
await mcp.disconnect();
```

### Multiple Servers

Multiple MCP servers can be configured at once. Tools from all servers are merged into a single toolkit.

```typescript
const mcp = new McpToolProvider({
  servers: [
    {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
    {
      name: "database",
      command: "node",
      args: ["./my-db-server.js"],
      env: { DATABASE_URL: "postgres://localhost/mydb" },
    },
  ],
});
```

### Tool Overrides

By default, all MCP tools are `parallelizable: true`. Specific tools with side effects or ordering requirements can be overridden.

```typescript
// inside the servers array
{
  name: "database",
  command: "node",
  args: ["./my-db-server.js"],
  tool_overrides: {
    "execute_query": { parallelizable: false },
    "create_table": { parallelizable: false },
  },
}
```

## License

MIT
