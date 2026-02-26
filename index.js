import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const LINQ_TOKEN = process.env.LINQ_TOKEN;
const LINQ_FROM = process.env.LINQ_FROM; // your Linq virtual number
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();
app.use(express.json());

// ── MCP Client Pool (one per user) ─────────────────────────────────
const mcpClients = new Map(); // phone → { client, transport }

async function getMcpClient(phone, mcpUrl) {
  // Return cached client if still connected
  if (mcpClients.has(phone)) {
    return mcpClients.get(phone).client;
  }

  const client = new Client({ name: "weave-sms", version: "1.0.0" });

  try {
    // Try Streamable HTTP first (newer MCP protocol)
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await client.connect(transport);
    mcpClients.set(phone, { client, transport });
    console.log(`[MCP] Connected via StreamableHTTP for ${phone}`);
    return client;
  } catch (e) {
    try {
      // Fall back to SSE transport
      const transport = new SSEClientTransport(new URL(mcpUrl));
      await client.connect(transport);
      mcpClients.set(phone, { client, transport });
      console.log(`[MCP] Connected via SSE for ${phone}`);
      return client;
    } catch (e2) {
      console.error(`[MCP] Failed to connect for ${phone}:`, e2.message);
      throw new Error("Could not connect to your MCP server. Please check your URL and try again.");
    }
  }
}

async function disconnectMcp(phone) {
  if (mcpClients.has(phone)) {
    try {
      await mcpClients.get(phone).client.close();
    } catch (_) {}
    mcpClients.delete(phone);
  }
}

// ── Supabase helpers ────────────────────────────────────────────────
async function getUser(phone) {
  const { data } = await supabase
    .from("sms_users")
    .select("*")
    .eq("phone_number", phone)
    .single();
  return data;
}

async function createUser(phone) {
  const { data } = await supabase
    .from("sms_users")
    .insert({ phone_number: phone })
    .select()
    .single();
  return data;
}

async function updateUser(phone, updates) {
  await supabase
    .from("sms_users")
    .update({ ...updates, last_active_at: new Date().toISOString() })
    .eq("phone_number", phone);
}

async function saveMessage(phone, role, content) {
  await supabase
    .from("sms_conversations")
    .insert({ phone_number: phone, role, content });
}

async function getRecentMessages(phone, limit = 10) {
  const { data } = await supabase
    .from("sms_conversations")
    .select("role, content")
    .eq("phone_number", phone)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data || []).reverse();
}

// ── Linq SMS sender ─────────────────────────────────────────────────
async function sendSms(to, message) {
  // Truncate to SMS-friendly length (split long messages)
  const chunks = splitMessage(message, 1500);
  for (const chunk of chunks) {
    const res = await fetch("https://api.linqapp.com/api/partner/v3/chats", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LINQ_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: LINQ_FROM,
        to: [to],
        message: {
          parts: [{ type: "text", value: chunk }],
        },
      }),
    });
    if (!res.ok) {
      console.error(`[Linq] Send failed:`, await res.text());
    }
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at last newline or space before maxLen
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// ── Claude + MCP tool execution ─────────────────────────────────────
const SYSTEM_PROMPT = `You are Weave — a personal memory assistant available over SMS.
You help people save, recall, and manage their memories using the Weave memory tools.

Keep responses SHORT and SMS-friendly (under 300 chars when possible).
Use plain text — no markdown, no bullet points, no headers.
Be warm, concise, and conversational.

When the user wants to save something, use weave_create_memory.
When they ask "what do I know about X" or want to recall, use weave_chat or weave_list_memories.
When they want to forget something, first use weave_list_memories to find it, then weave_forget_memory.
When they want to organize, use weave_add_tag or weave_list_tags.

Always confirm actions briefly: "Saved!" or "Found 3 memories about cooking."`;

async function processWithClaude(phone, userMessage, mcpClient) {
  // Get available MCP tools
  const { tools: mcpTools } = await mcpClient.listTools();

  // Convert MCP tools to Claude tool format
  const claudeTools = mcpTools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || { type: "object", properties: {} },
  }));

  // Build conversation history
  const history = await getRecentMessages(phone);
  const messages = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  messages.push({ role: "user", content: userMessage });

  // Call Claude with tool use
  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: claudeTools,
    messages,
  });

  // Handle tool use loop
  let iterations = 0;
  while (response.stop_reason === "tool_use" && iterations < 5) {
    iterations++;
    const toolBlocks = response.content.filter((b) => b.type === "tool_use");
    const toolResults = [];

    for (const toolBlock of toolBlocks) {
      console.log(`[Claude] Calling tool: ${toolBlock.name}`, JSON.stringify(toolBlock.input));
      try {
        const result = await mcpClient.callTool({
          name: toolBlock.name,
          arguments: toolBlock.input,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: JSON.stringify(result.content),
        });
      } catch (err) {
        console.error(`[MCP] Tool error:`, err.message);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: `Error: ${err.message}`,
          is_error: true,
        });
      }
    }

    // Continue conversation with tool results
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: claudeTools,
      messages,
    });
  }

  // Extract final text response
  const textBlocks = response.content.filter((b) => b.type === "text");
  return textBlocks.map((b) => b.text).join("\n") || "Done!";
}

// ── Webhook handler ─────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Respond immediately so Linq doesn't retry
  res.status(200).json({ ok: true });

  try {
    const body = req.body;
    console.log("[Webhook] Received:", JSON.stringify(body).slice(0, 500));

    // Extract phone and message from Linq webhook payload
    const phone = body.from || body.sender || body.phone;
    const message =
      body.message?.parts?.[0]?.value ||
      body.message?.text ||
      body.text ||
      body.message ||
      "";

    if (!phone || !message) {
      console.log("[Webhook] Missing phone or message, skipping");
      return;
    }

    console.log(`[SMS] From ${phone}: ${message}`);

    // Look up or create user
    let user = await getUser(phone);
    if (!user) {
      user = await createUser(phone);
      await sendSms(
        phone,
        "Welcome to Weave! I'm your personal memory assistant over SMS.\n\nTo get started, I need your Weave MCP URL. You can find it in your Weave settings.\n\nPlease paste your MCP URL:"
      );
      return;
    }

    // Onboarding: waiting for MCP URL
    if (user.status === "awaiting_mcp_url") {
      const trimmed = message.trim();

      // Basic URL validation
      if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
        await sendSms(
          phone,
          "That doesn't look like a URL. Please send your Weave MCP URL (starts with https://...)"
        );
        return;
      }

      // Try to connect
      try {
        await getMcpClient(phone, trimmed);
        await updateUser(phone, { mcp_url: trimmed, status: "active" });
        await sendSms(
          phone,
          "Connected! Your Weave memory is now linked.\n\nTry:\n- \"Remember that my dentist appt is March 5\"\n- \"What do I know about recipes?\"\n- \"Show my memories\"\n\nJust text me anytime!"
        );
      } catch (err) {
        await sendSms(
          phone,
          `Couldn't connect to that MCP URL: ${err.message}\n\nPlease double-check and try again.`
        );
      }
      return;
    }

    // Active user: process with Claude + MCP
    if (user.status === "active" && user.mcp_url) {
      // Save the incoming message
      await saveMessage(phone, "user", message);

      try {
        const mcpClient = await getMcpClient(phone, user.mcp_url);
        const reply = await processWithClaude(phone, message, mcpClient);

        // Save and send the response
        await saveMessage(phone, "assistant", reply);
        await sendSms(phone, reply);
      } catch (err) {
        console.error(`[Error] Processing for ${phone}:`, err);

        // If MCP connection failed, try reconnecting
        await disconnectMcp(phone);

        if (err.message?.includes("MCP") || err.message?.includes("connect")) {
          await updateUser(phone, { status: "awaiting_mcp_url" });
          await sendSms(
            phone,
            "Lost connection to your Weave memory. Please send your MCP URL again to reconnect."
          );
        } else {
          await sendSms(phone, "Sorry, something went wrong. Please try again in a moment.");
        }
      }
      return;
    }

    // Fallback
    await sendSms(phone, "Something went wrong. Text RESET to start over.");
  } catch (err) {
    console.error("[Webhook] Unhandled error:", err);
  }
});

// Handle RESET command
app.post("/webhook", async (req, res) => {
  // This is handled in the main webhook above
});

// ── Health check ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    service: "weave-fabric-sms",
    status: "running",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Weave Fabric SMS running on port ${PORT}`);
});
