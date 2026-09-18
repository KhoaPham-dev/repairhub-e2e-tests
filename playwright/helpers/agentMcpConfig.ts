/**
 * Shared test-run constants for the Agent API / MCP server E2E specs
 * (26-agent-api.spec.ts, 27-mcp-server.spec.ts, RH-149).
 *
 * These MUST match the env vars the backend/MCP processes were actually
 * started with for this run (AGENT_API_KEY on the backend and MCP, and
 * MCP_ACCESS_TOKEN on the MCP server) — override via E2E_AGENT_API_KEY /
 * E2E_MCP_ACCESS_TOKEN if a different value is used when starting them.
 */

export const AGENT_API_KEY = process.env.E2E_AGENT_API_KEY ?? 'e2e-agent-api-test-key-0123456789abcdef';

// Must be >= MIN_MCP_ACCESS_TOKEN_LENGTH (32) per repairhub-mcp/src/config.ts.
export const MCP_ACCESS_TOKEN = process.env.E2E_MCP_ACCESS_TOKEN ?? 'e2e-mcp-access-token-0123456789abcdefXYZ';
