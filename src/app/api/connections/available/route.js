import { NextResponse } from "next/server";
import { getProviderConnections, getAvailableConnectionsForApiKey, getProviderNodes } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/connections/available?apiKeyId=xxx
// Returns connections available for allocation to a specific API key
// (unassigned connections + connections already assigned to this key)
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const apiKeyId = searchParams.get("apiKeyId");

    let connections;
    if (apiKeyId) {
      // Get connections available for this specific API key
      connections = await getAvailableConnectionsForApiKey(apiKeyId, { isActive: true });
    } else {
      // Get all unassigned connections
      connections = await getProviderConnections({ isActive: true, assignedToApiKeyId: null });
    }

    // Filter by testStatus - only show active connections for selection
    // BUT: keep already-assigned connections even if unavailable (user needs to see what's allocated)
    connections = connections.filter(c =>
      (!c.testStatus || c.testStatus === "active") ||
      (apiKeyId && c.assignedToApiKeyId === apiKeyId)
    );

    // Get custom provider nodes to extract prefixes
    // Must query each type separately (getProviderNodes doesn't support array)
    const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
    const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
    const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
    const customNodes = [...openaiNodes, ...anthropicNodes, ...embeddingNodes];
    const nodeMap = new Map(customNodes.map(n => [n.id, n]));

    // Add customPrefix to each connection
    const connectionsWithPrefix = connections.map(conn => {
      let customPrefix = null;
      if (conn.provider.startsWith('openai-compatible-') ||
          conn.provider.startsWith('anthropic-compatible-') ||
          conn.provider.startsWith('custom-embedding-')) {
        const node = nodeMap.get(conn.provider);
        customPrefix = node?.prefix || null;
      }

      return {
        id: conn.id,
        provider: conn.provider,
        name: conn.name || conn.email || conn.id,
        displayName: conn.displayName || conn.name || conn.email || conn.id,
        email: conn.email,
        authType: conn.authType,
        assignedToApiKeyId: conn.assignedToApiKeyId,
        providerSpecificData: conn.providerSpecificData || {},
        customPrefix, // For matching custom provider models
      };
    });

    // Group by provider for easier UI rendering
    const grouped = connectionsWithPrefix.reduce((acc, conn) => {
      if (!acc[conn.provider]) acc[conn.provider] = [];
      acc[conn.provider].push(conn);
      return acc;
    }, {});

    return NextResponse.json({ connections: connectionsWithPrefix, grouped });
  } catch (error) {
    console.log("Error fetching available connections:", error);
    return NextResponse.json(
      { error: "Failed to fetch connections" },
      { status: 500 }
    );
  }
}
