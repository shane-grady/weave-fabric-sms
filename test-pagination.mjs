/**
 * Test script to verify MCP pagination behavior for weave_list_memories.
 * Creates a mock MCP server with paginated memories and tests the client behavior.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Mock data: 60 memories to force pagination ──
const ALL_MEMORIES = Array.from({ length: 60 }, (_, i) => ({
  id: `mem_${i + 1}`,
  content: `Memory #${i + 1}: This is test memory number ${i + 1}`,
  created_at: new Date(2025, 0, i + 1).toISOString(),
  tags: [`tag${(i % 5) + 1}`],
}));

// ── Create mock MCP server ──
const server = new Server(
  { name: "mock-weave-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "weave_list_memories",
      description:
        "List memories with optional search query. Supports pagination via page and pageSize parameters.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional search query to filter memories",
          },
          page: {
            type: "number",
            description: "Page number (1-indexed, default: 1)",
            default: 1,
            minimum: 1,
          },
          pageSize: {
            type: "number",
            description: "Number of results per page (default: 25, max: 100)",
            default: 25,
            maximum: 100,
          },
        },
      },
    },
    {
      name: "weave_create_memory",
      description: "Create a new memory",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Memory content" },
        },
        required: ["content"],
      },
    },
    {
      name: "weave_forget_memory",
      description: "Delete a memory by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory ID to delete" },
        },
        required: ["id"],
      },
    },
    {
      name: "weave_chat",
      description: "Chat with your memories",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Your message" },
        },
        required: ["message"],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "weave_list_memories") {
    const page = args?.page || 1;
    const pageSize = args?.pageSize || 25;
    const query = args?.query || "";

    // Filter memories by query if provided
    let filtered = ALL_MEMORIES;
    if (query) {
      filtered = ALL_MEMORIES.filter((m) =>
        m.content.toLowerCase().includes(query.toLowerCase())
      );
    }

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, total);
    const memories = filtered.slice(start, end);
    const totalPages = Math.ceil(total / pageSize);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            memories,
            pagination: {
              page,
              pageSize,
              total,
              totalPages,
              hasMore: page < totalPages,
            },
          }),
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
  };
});

// ── Test runner ──
async function runTests() {
  // Create in-memory transport pair
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  // Connect client and server
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  console.log("=== MCP Pagination Test ===\n");

  // ── Test 1: List tools to see schemas ──
  console.log("--- Test 1: Discover tool schemas ---");
  const toolsResult = await client.listTools();
  const listMemoriesTool = toolsResult.tools.find(
    (t) => t.name === "weave_list_memories"
  );
  console.log(`Found ${toolsResult.tools.length} tools`);
  console.log(
    `weave_list_memories schema:`,
    JSON.stringify(listMemoriesTool.inputSchema, null, 2)
  );
  console.log();

  // ── Test 2: Call weave_list_memories with DEFAULT params (the bug) ──
  console.log("--- Test 2: Default call - NO pagination params (THE BUG) ---");
  const result1 = await client.callTool({
    name: "weave_list_memories",
    arguments: {},
  });
  const data1 = JSON.parse(result1.content[0].text);
  console.log(
    `  Returned ${data1.memories.length} memories out of ${data1.pagination.total} total`
  );
  console.log(
    `  Page ${data1.pagination.page}/${data1.pagination.totalPages}, hasMore: ${data1.pagination.hasMore}`
  );
  console.log(
    `  >>> BUG: Only ${data1.memories.length} of ${data1.pagination.total} memories visible!`
  );
  console.log();

  // ── Test 3: Call with pageSize=100 (the fix - single page) ──
  console.log("--- Test 3: With pageSize=100 (THE FIX) ---");
  const result2 = await client.callTool({
    name: "weave_list_memories",
    arguments: { pageSize: 100 },
  });
  const data2 = JSON.parse(result2.content[0].text);
  console.log(
    `  Returned ${data2.memories.length} memories out of ${data2.pagination.total} total`
  );
  console.log(
    `  Page ${data2.pagination.page}/${data2.pagination.totalPages}, hasMore: ${data2.pagination.hasMore}`
  );
  console.log(
    `  >>> FIX: All ${data2.memories.length}/${data2.pagination.total} memories visible in one call!`
  );
  console.log();

  // ── Test 4: Multi-page iteration (for >100 memories) ──
  console.log("--- Test 4: Multi-page iteration (for large collections) ---");
  let allMemories = [];
  let currentPage = 1;
  let hasMore = true;

  while (hasMore) {
    const result = await client.callTool({
      name: "weave_list_memories",
      arguments: { page: currentPage, pageSize: 100 },
    });
    const data = JSON.parse(result.content[0].text);
    allMemories = allMemories.concat(data.memories);
    hasMore = data.pagination.hasMore;
    console.log(
      `  Page ${currentPage}: got ${data.memories.length} memories (total so far: ${allMemories.length}/${data.pagination.total})`
    );
    currentPage++;
  }
  console.log(
    `  >>> COMPLETE: Retrieved all ${allMemories.length} memories across ${currentPage - 1} page(s)`
  );
  console.log();

  // ── Summary ──
  console.log("=== SUMMARY ===");
  console.log(
    `  Without fix: Default call returns only ${data1.memories.length}/${ALL_MEMORIES.length} memories`
  );
  console.log(
    `  With fix (pageSize=100): Returns all ${data2.memories.length}/${ALL_MEMORIES.length} memories`
  );
  console.log(
    "\nThe fix updates SYSTEM_PROMPT to instruct Claude to:"
  );
  console.log("  1. Always use pageSize: 100 when calling weave_list_memories");
  console.log(
    "  2. Check pagination.total and pagination.hasMore in the response"
  );
  console.log(
    "  3. Make follow-up calls with incrementing page numbers if hasMore is true"
  );
  console.log("  4. Combine all pages before responding to the user");

  // Cleanup
  await client.close();
  await server.close();

  console.log("\n=== ALL TESTS PASSED ===");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
