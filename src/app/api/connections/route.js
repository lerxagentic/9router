import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/connections - List all provider connections
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const isActive = searchParams.get("isActive");
    const assignedOnly = searchParams.get("assignedOnly");
    const assignedToApiKeyId = searchParams.get("assignedToApiKeyId");

    const filter = {};
    if (provider) filter.provider = provider;
    if (isActive !== null) filter.isActive = isActive === "true";
    if (assignedToApiKeyId) filter.assignedToApiKeyId = assignedToApiKeyId;
    // ponytail: assignedOnly filter - when we need filtering by "has assignment" not specific key
    if (assignedOnly === "true") {
      // Will need to filter after fetch since schema doesn't support "NOT NULL" filter
    }

    let connections = await getProviderConnections(filter);

    // Filter assigned connections if requested
    if (assignedOnly === "true") {
      connections = connections.filter(c => c.assignedToApiKeyId !== null);
    }

    // Return minimal data for UI
    const mapped = connections.map(c => ({
      id: c.id,
      provider: c.provider,
      name: c.name || c.email || c.id,
      email: c.email,
      authType: c.authType,
      isActive: c.isActive,
      assignedToApiKeyId: c.assignedToApiKeyId,
    }));

    return NextResponse.json({ connections: mapped });
  } catch (error) {
    console.log("Error fetching connections:", error);
    return NextResponse.json(
      { error: "Failed to fetch connections" },
      { status: 500 }
    );
  }
}
