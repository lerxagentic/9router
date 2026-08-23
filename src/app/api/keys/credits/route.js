import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

/**
 * GET /api/keys/credits
 * Returns connection assignments for all API keys to enable client-side quota aggregation
 *
 * Response: {
 *   assignments: {
 *     keyId: [connectionId1, connectionId2, ...]
 *   }
 * }
 *
 * Client aggregates quota from its localStorage cache
 */
export async function GET() {
  try {
    // Fetch all connections with assignments
    const connections = await getProviderConnections({ isActive: true });
    const assignedConnections = connections.filter(c => c.assignedToApiKeyId !== null);

    // Group by API key
    const assignments = {};
    for (const conn of assignedConnections) {
      const keyId = conn.assignedToApiKeyId;
      if (!assignments[keyId]) {
        assignments[keyId] = [];
      }
      assignments[keyId].push(conn.id);
    }

    return NextResponse.json({
      assignments,
      timestamp: Date.now() // For cache validation
    });
  } catch (error) {
    console.error("Error fetching key credits:", error);
    return NextResponse.json(
      { error: "Failed to fetch key credits" },
      { status: 500 }
    );
  }
}
