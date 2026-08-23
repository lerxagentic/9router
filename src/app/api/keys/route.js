import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key (limits, reset period, model scope, connection allocation)
export async function POST(request) {
  try {
    const body = await request.json();
    const {
      name,
      tokenLimit,
      requestLimit,
      resetPeriod,
      customResetDays,
      scopeType,
      allowedModels,
      allowedCombos,
      allocatedConnectionIds,
    } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();

    const options = {
      tokenLimit: tokenLimit !== undefined ? tokenLimit : null,
      requestLimit: requestLimit !== undefined ? requestLimit : null,
      resetPeriod: resetPeriod || 'monthly',
      customResetDays: customResetDays || null,
      scopeType: scopeType || 'global',
      allowedModels: allowedModels || null,
      allowedCombos: allowedCombos || null,
    };

    const apiKey = await createApiKey(name, machineId, options);

    // Handle connection allocation if provided
    if (allocatedConnectionIds && allocatedConnectionIds.length > 0) {
      const allConnections = await getProviderConnections({});
      const connMap = new Map(allConnections.map(c => [c.id, c]));

      for (const connId of allocatedConnectionIds) {
        const existingConn = connMap.get(connId);
        if (!existingConn) {
          return NextResponse.json(
            { error: `Connection ${connId} not found` },
            { status: 400 }
          );
        }
        if (existingConn.assignedToApiKeyId && existingConn.assignedToApiKeyId !== apiKey.id) {
          return NextResponse.json(
            { error: `Connection ${connId} is already assigned to another API key` },
            { status: 409 }
          );
        }
        await updateProviderConnection(connId, { assignedToApiKeyId: apiKey.id });
      }
    }

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      tokenLimit: apiKey.tokenLimit,
      requestLimit: apiKey.requestLimit,
      tokensUsed: apiKey.tokensUsed,
      requestsUsed: apiKey.requestsUsed,
      resetPeriod: apiKey.resetPeriod,
      customResetDays: apiKey.customResetDays,
      resetAt: apiKey.resetAt,
      scopeType: apiKey.scopeType,
      allowedModels: apiKey.allowedModels,
      allowedCombos: apiKey.allowedCombos,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
