import type { LifecycleErrorEvent } from "@simulacra-ai/core";

/**
 * Configuration for a single Model Context Protocol (MCP) server connection.
 *
 * This interface defines how to connect to and configure an MCP server,
 * including the command to execute, environment variables, and tool-specific
 * overrides.
 */
export interface McpServerConfig {
  /**
   * A unique identifier for this MCP server.
   */
  name: string;

  /**
   * The command to execute to start the MCP server process.
   */
  command: string;

  /**
   * Command-line arguments to pass to the server command.
   */
  args?: string[];

  /**
   * Environment variables to set for the server process.
   */
  env?: Record<string, string>;

  /**
   * The transport mechanism used to communicate with the server.
   * Currently only "stdio" is supported.
   */
  transport?: "stdio";

  /**
   * Tool-specific configuration overrides, keyed by tool name.
   */
  tool_overrides?: Record<
    string,
    {
      /**
       * Whether this tool can be executed in parallel with other tools.
       */
      parallelizable?: boolean;
    }
  >;
}

/**
 * Configuration for the MCP tool provider.
 *
 * This interface defines the configuration needed to connect to one or more
 * MCP servers and make their tools available to a Simulacra workflow.
 */
export interface McpToolProviderConfig {
  /**
   * An array of MCP server configurations to connect to.
   */
  servers: McpServerConfig[];

  /**
   * Optional callback invoked when a background operation fails during cleanup or disposal.
   */
  on_error?: (event: LifecycleErrorEvent) => void;
}
