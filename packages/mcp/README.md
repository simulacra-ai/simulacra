# Simulacra MCP Bridge

MCP (Model Context Protocol) client bridge for the Simulacra conversation engine. Connects to MCP servers and exposes their tools as Simulacra tool classes.

## Installation

```bash
npm install @simulacra-ai/core @simulacra-ai/mcp @modelcontextprotocol/sdk
```

## Usage

```typescript
import { Conversation, WorkflowManager } from "@simulacra-ai/core";
import { AnthropicProvider } from "@simulacra-ai/anthropic";
import Anthropic from "@anthropic-ai/sdk";
import { McpToolProvider } from "@simulacra-ai/mcp";

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

const provider = new AnthropicProvider(new Anthropic(), { model: MODEL_NAME });
const conversation = new Conversation(provider);
conversation.toolkit = [...conversation.toolkit, ...mcp.getToolClasses()];
const manager = new WorkflowManager(conversation);

await conversation.prompt("List the files in /tmp");

await mcp.disconnect();
```

### Multiple Servers

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

By default, all MCP tools are `parallelizable: true`. Override specific tools with side effects or ordering requirements:

```typescript
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
