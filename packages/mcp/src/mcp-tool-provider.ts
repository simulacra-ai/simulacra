import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  ToolClass,
  ToolDefinition,
  ToolContext,
  ToolSuccessResult,
  ToolErrorResult,
} from "@simulacra-ai/core";
import { convertJsonSchemaToParameters } from "./schema-converter.ts";
import type { McpServerConfig, McpToolProviderConfig } from "./types.ts";

interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport;
}

/**
 * A provider that connects to Model Context Protocol (MCP) servers and exposes
 * their tools as Simulacra-compatible tool classes.
 *
 * This class manages the lifecycle of MCP server connections, converts MCP tools
 * into the Simulacra tool format, and provides access to all tools from connected
 * servers.
 */
export class McpToolProvider {
  readonly #config: McpToolProviderConfig;
  #servers: ConnectedServer[] = [];
  #tool_classes: ToolClass[] = [];

  /**
   * Creates a new MCP tool provider.
   *
   * @param config - Configuration specifying which MCP servers to connect to.
   */
  constructor(config: McpToolProviderConfig) {
    this.#config = config;
  }

  /**
   * Establishes connections to all configured MCP servers and retrieves their tools.
   *
   * This method spawns each server process, establishes communication over stdio,
   * and queries each server for its available tools. The tools are converted to
   * Simulacra-compatible tool classes and stored internally.
   *
   * @returns A promise that resolves when all servers are connected and tools are loaded.
   */
  async connect(): Promise<void> {
    const connected: ConnectedServer[] = [];
    const added_tool_classes: ToolClass[] = [];
    try {
      for (const server_config of this.#config.servers) {
        const transport = new StdioClientTransport({
          command: server_config.command,
          args: server_config.args,
          env: server_config.env,
        });

        const client = new Client({ name: "simulacra", version: "0.1.0" }, { capabilities: {} });

        await client.connect(transport);

        const server: ConnectedServer = { config: server_config, client, transport };
        connected.push(server);
        this.#servers.push(server);

        const tools_result = await client.listTools();

        for (const mcp_tool of tools_result.tools) {
          const tool_class = this.#create_tool_class(client, mcp_tool, server_config);
          added_tool_classes.push(tool_class);
          this.#tool_classes.push(tool_class);
        }
      }
    } catch (error) {
      for (const server of connected) {
        await server.client.close().catch((close_error) => {
          this.#config.on_error?.({
            error: close_error,
            operation: "disconnect",
            context: { during: "connect_rollback" },
          });
        });
      }
      this.#servers = this.#servers.filter((s) => !connected.includes(s));
      this.#tool_classes = this.#tool_classes.filter((t) => !added_tool_classes.includes(t));
      throw error;
    }
  }

  /**
   * Closes all MCP server connections and clears the cached tool classes.
   *
   * This method gracefully shuts down all server processes and cleans up
   * internal state. After calling this method, the tool classes are no longer
   * available.
   *
   * @returns A promise that resolves when all servers are disconnected.
   */
  async disconnect(): Promise<void> {
    await Promise.allSettled(this.#servers.map((s) => s.client.close()));
    this.#servers = [];
    this.#tool_classes = [];
  }

  /**
   * Enables automatic cleanup when the provider is disposed.
   *
   * This method implements the disposable pattern, allowing the provider to be
   * used with explicit resource management syntax (using keyword). When disposed,
   * it attempts to disconnect from all servers.
   */
  [Symbol.dispose]() {
    this.disconnect().catch((error) => {
      this.#config.on_error?.({ error, operation: "disconnect", context: { during: "dispose" } });
    });
  }

  /**
   * Retrieves all tool classes from connected MCP servers.
   *
   * This method returns a shallow copy of the internal tool classes array,
   * containing Simulacra-compatible tool classes for all tools from all
   * connected servers.
   *
   * @returns An array of tool classes ready to be used in a Simulacra workflow.
   */
  getToolClasses(): ToolClass[] {
    return [...this.#tool_classes];
  }

  #create_tool_class(
    client: Client,
    mcp_tool: { name: string; description?: string; inputSchema?: unknown },
    server_config: McpServerConfig,
  ): ToolClass {
    const parameters = mcp_tool.inputSchema
      ? convertJsonSchemaToParameters(mcp_tool.inputSchema as Record<string, unknown>)
      : [];

    const parallelizable = server_config.tool_overrides?.[mcp_tool.name]?.parallelizable;

    const definition: ToolDefinition = {
      name: mcp_tool.name,
      description: mcp_tool.description ?? "",
      parameters,
      ...(parallelizable !== undefined ? { parallelizable } : {}),
    };

    const McpTool = class {
      static get_definition() {
        return definition;
      }

      constructor(_context: ToolContext) {}

      async execute(params: Record<string, unknown>): Promise<ToolSuccessResult | ToolErrorResult> {
        try {
          const result = await client.callTool({
            name: mcp_tool.name,
            arguments: params,
          });

          if (result.isError) {
            const text =
              (result.content as Array<{ type: string; text?: string }>)
                ?.filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("\n") || "MCP tool error";
            return { result: false, message: text };
          }

          const text = (result.content as Array<{ type: string; text?: string }>)
            ?.filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("\n");
          return {
            result: true,
            ...({ output: text || "success" } as Record<string, unknown>),
          } as ToolSuccessResult;
        } catch (error) {
          return {
            result: false,
            message: error instanceof Error ? error.message : String(error),
            error,
          };
        }
      }
    };

    return McpTool as unknown as ToolClass;
  }
}
