import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey, getProviderConnections, updateProviderConnection } from "@/lib/localDb";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key (limits, reset period, model scope, connection allocation)
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const {
      name,
      isActive,
      tokenLimit,
      requestLimit,
      tokensUsed,
      requestsUsed,
      resetPeriod,
      customResetDays,
      scopeType,
      allowedModels,
      allowedCombos,
      allocatedConnectionIds,
    } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (tokenLimit !== undefined) updateData.tokenLimit = tokenLimit;
    if (requestLimit !== undefined) updateData.requestLimit = requestLimit;
    if (tokensUsed !== undefined) updateData.tokensUsed = tokensUsed;
    if (requestsUsed !== undefined) updateData.requestsUsed = requestsUsed;
    if (resetPeriod !== undefined) updateData.resetPeriod = resetPeriod;
    if (customResetDays !== undefined) updateData.customResetDays = customResetDays;
    if (scopeType !== undefined) updateData.scopeType = scopeType;
    if (allowedModels !== undefined) updateData.allowedModels = allowedModels;
    if (allowedCombos !== undefined) updateData.allowedCombos = allowedCombos;

    const updated = await updateApiKey(id, updateData);

    // Handle connection allocation
    if (allocatedConnectionIds !== undefined) {
      const currentlyAssigned = await getProviderConnections({ assignedToApiKeyId: id });

      // Unassign old connections (not in new list)
      const newSet = new Set(allocatedConnectionIds);
      for (const conn of currentlyAssigned) {
        if (!newSet.has(conn.id)) {
          await updateProviderConnection(conn.id, { assignedToApiKeyId: null });
        }
      }

      // Assign new connections with validation
      const currentlyAssignedSet = new Set(currentlyAssigned.map(c => c.id));
      const allConnections = await getProviderConnections({});
      const connMap = new Map(allConnections.map(c => [c.id, c]));

      for (const connId of allocatedConnectionIds) {
        if (!currentlyAssignedSet.has(connId)) {
          const existingConn = connMap.get(connId);
          if (!existingConn) {
            return NextResponse.json(
              { error: `Connection ${connId} not found` },
              { status: 400 }
            );
          }
          if (existingConn.assignedToApiKeyId && existingConn.assignedToApiKeyId !== id) {
            return NextResponse.json(
              { error: `Connection ${connId} is already assigned to another API key` },
              { status: 409 }
            );
          }
          await updateProviderConnection(connId, { assignedToApiKeyId: id });
        }
      }
    }

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key (releases allocated connections back to global pool)
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    // Release connections that were allocated to this key
    const allocated = await getProviderConnections({ assignedToApiKeyId: id });
    for (const conn of allocated) {
      await updateProviderConnection(conn.id, { assignedToApiKeyId: null });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
