"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Card, Button, Input, Modal, CardSkeleton, Toggle, ConfirmModal, ModelSelectModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  TUNNEL_BENEFITS,
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PING_MAX_MS,
  STATUS_POLL_FAST_MS,
  REACHABLE_MISS_THRESHOLD,
  CLIENT_PING_FAST_MS,
} from "./endpointConstants";
import { clientPingUrl, clientPingAny } from "./endpointPing";
import EndpointRow from "./components/EndpointRow";
import StatusAlert from "./components/StatusAlert";
import Tooltip from "./components/Tooltip";
import SecurityWarning from "./components/SecurityWarning";
export default function APIPageClient({ machineId }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  // API key form state (for create/edit)
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedKey, setSelectedKey] = useState(null);
  const [keyForm, setKeyForm] = useState({
    name: "",
    tokenLimit: null,
    requestLimit: null,
    resetPeriod: "monthly",
    customResetDays: null,
    scopeType: "global",
    allowedModels: [],
    allowedCombos: [],
    allocatedConnectionIds: [],
  });

  // Model/combo select modals
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [showComboSelect, setShowComboSelect] = useState(false);
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [combos, setCombos] = useState([]);

  // Connection allocation
  const [availableConnections, setAvailableConnections] = useState([]);
  const [showConnectionSelect, setShowConnectionSelect] = useState(false);
  const [connectionSearchQuery, setConnectionSearchQuery] = useState("");
  const [expandedProviders, setExpandedProviders] = useState(new Set());

  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
 const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);

 // Token Auto-Refresh state
  const [tokenAutoRefreshEnabled, setTokenAutoRefreshEnabled] = useState(false);
  const [tokenAutoRefreshLastRunAt, setTokenAutoRefreshLastRunAt] = useState(null);
  const [tokenAutoRefreshStats, setTokenAutoRefreshStats] = useState({
    accountsChecked: 0,
    accountsRefreshed: 0,
    successCount: 0,
    failureCount: 0,
  });

 // Cloudflare Tunnel state
  const [tunnelChecking, setTunnelChecking] = useState(true);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelReachable, setTunnelReachable] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelProgress, setTunnelProgress] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState(null);
  const [showEnableTunnelModal, setShowEnableTunnelModal] = useState(false);
  const [showDisableTunnelModal, setShowDisableTunnelModal] = useState(false);

  // Tailscale state
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsReachable, setTsReachable] = useState(false);
  const [tsUrl, setTsUrl] = useState("");
  const [tsLoading, setTsLoading] = useState(false);
  const [tsProgress, setTsProgress] = useState("");
  const [tsStatus, setTsStatus] = useState(null);
  const [tsAuthUrl, setTsAuthUrl] = useState("");
  const [tsAuthLabel, setTsAuthLabel] = useState("");
  const [tsInstalled, setTsInstalled] = useState(null); // null=checking, true/false
  const [tsInstalling, setTsInstalling] = useState(false);
  const [tsInstallLog, setTsInstallLog] = useState([]);
  const [tsSudoPassword, setTsSudoPassword] = useState("");
  const [tsConnecting, setTsConnecting] = useState(false);
  const [showTsModal, setShowTsModal] = useState(false);
  const [showDisableTsModal, setShowDisableTsModal] = useState(false);
  const tsLogRef = useRef(null);

  // Debounce reachable=false: server may briefly return false during background refresh.
  // Only flip UI to "reconnecting" after N consecutive misses to avoid spinner flicker.
  const tunnelMissRef = useRef(0);
  const tsMissRef = useRef(0);
  // Browser-side reachable cache (independent of backend DNS quirks)
  const tunnelClientReachableRef = useRef(false);
  const tsClientReachableRef = useRef(false);
  // Track whether reachable=true was ever observed in this session.
  // Distinguishes "Checking..." (initial cold cache) from "Reconnecting..." (lost connection).
  const tunnelEverReachableRef = useRef(false);
  const tsEverReachableRef = useRef(false);
  const [tunnelEverReachable, setTunnelEverReachable] = useState(false);
  const [tsEverReachable, setTsEverReachable] = useState(false);

  // API key visibility toggle state
  const [visibleKeys, setVisibleKeys] = useState(new Set());

  // Connection quota tracking for each API key
  const [keyQuotas, setKeyQuotas] = useState({}); // {keyId: {used, total, loading, error}}

  // Client-side local/remote detection (UI hint only, not a security gate)
  const [isRemoteHost, setIsRemoteHost] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined")
      setIsRemoteHost(!["localhost", "127.0.0.1", "::1"].includes(window.location.hostname));
  }, []);

  const { copied, copy } = useCopyToClipboard();

  // Security gate: block remote exposure while dashboard uses default password or login is off.
  const isLoginUnsafe = !requireLogin || !hasPassword;
  const unsafeReason = !requireLogin
    ? "Enable \"Require login\" and set a custom password before activating the tunnel."
    : "Change the default dashboard password before activating the tunnel.";

  // Auto-scroll install log
  useEffect(() => {
    if (tsLogRef.current) tsLogRef.current.scrollTop = tsLogRef.current.scrollHeight;
  }, [tsInstallLog]);

  useEffect(() => {
    fetchData();
    loadSettings();
  }, []);

  // Status poll: only while degraded (not yet reachable). Stop once healthy to avoid spam.
  // Visibility re-check: refresh once when tab becomes visible.
  useEffect(() => {
    const anyEnabled = tunnelEnabled || tsEnabled;
    if (!anyEnabled) return;
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    const allHealthy = tunnelHealthy && tsHealthy;
    const onVisible = () => { if (!document.hidden) syncTunnelStatus(); };
    document.addEventListener("visibilitychange", onVisible);
    if (allHealthy) return () => document.removeEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => { if (!document.hidden) syncTunnelStatus(); }, STATUS_POLL_FAST_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tunnelEnabled, tsEnabled, tunnelReachable, tsReachable]);

  // Browser-side periodic ping: probes tunnel/tailscale URLs directly so UI stays
  // "reachable" even when backend DNS (1.1.1.1) hiccups on *.ts.net or *.trycloudflare.com.
  // Adaptive: slow when healthy, fast when degraded; pause when tab hidden.
  useEffect(() => {
    const probeBoth = async () => {
      if (document.hidden) return;
      if (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) {
        const ok = await clientPingAny(tunnelPublicUrl, tunnelUrl);
        tunnelClientReachableRef.current = ok;
        if (ok) { tunnelMissRef.current = 0; setTunnelReachable(true); if (!tunnelEverReachableRef.current) { tunnelEverReachableRef.current = true; setTunnelEverReachable(true); } }
        else { tunnelMissRef.current += 1; if (tunnelMissRef.current >= REACHABLE_MISS_THRESHOLD) setTunnelReachable(false); }
      } else {
        tunnelClientReachableRef.current = false;
      }
      if (tsEnabled && tsUrl) {
        const ok = await clientPingUrl(tsUrl);
        tsClientReachableRef.current = ok;
        if (ok) { tsMissRef.current = 0; setTsReachable(true); if (!tsEverReachableRef.current) { tsEverReachableRef.current = true; setTsEverReachable(true); } }
        else { tsMissRef.current += 1; if (tsMissRef.current >= REACHABLE_MISS_THRESHOLD) setTsReachable(false); }
      } else {
        tsClientReachableRef.current = false;
      }
    };
    const anyEnabled = (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) || (tsEnabled && tsUrl);
    if (!anyEnabled) return;
    probeBoth();
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    if (tunnelHealthy && tsHealthy) return;
    const id = setInterval(probeBoth, CLIENT_PING_FAST_MS);
    return () => clearInterval(id);
  }, [tunnelEnabled, tunnelUrl, tunnelPublicUrl, tsEnabled, tsUrl, tunnelReachable, tsReachable]);

  // Client-side reachable only (server no longer probes; watchdog handles backend health).
  // Miss-debounce: only flip to false after N consecutive misses.
  const updateReachable = useCallback((_unused, clientRef, missRef, setter, everRef, everSetter) => {
    const reachable = clientRef.current;
    if (reachable) {
      missRef.current = 0;
      setter(true);
      if (!everRef.current) {
        everRef.current = true;
        everSetter(true);
      }
    } else {
      missRef.current += 1;
      if (missRef.current >= REACHABLE_MISS_THRESHOLD) setter(false);
    }
  }, []);

  // Trust user intent (settingsEnabled): UI stays "enabled" while watchdog restarts process
  const syncTunnelStatus = async () => {
    try {
      const statusRes = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!statusRes.ok) return;
      const data = await statusRes.json();
      const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
      const tUrl = data.tunnel?.tunnelUrl || "";
      setTunnelUrl(tUrl);
      setTunnelPublicUrl(data.tunnel?.publicUrl || "");
      setTunnelEnabled(tEnabled);
      updateReachable(null, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

      const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
      const tsUrlVal = data.tailscale?.tunnelUrl || "";
      setTsUrl(tsUrlVal);
      setTsEnabled(tsEn);
      updateReachable(null, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
    } catch { /* ignore poll errors */ }
  };

  const loadSettings = async () => {
    setTunnelChecking(true);
    try {
      const [settingsRes, statusRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/tunnel/status", { cache: "no-store" })
      ]);
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setRequireApiKey(data.requireApiKey || false);
        setRequireLogin(data.requireLogin !== false);
        setHasPassword(data.hasPassword || false);
        setTunnelDashboardAccess(data.tunnelDashboardAccess || false);
        
        // Token Auto-Refresh settings
        setTokenAutoRefreshEnabled(data.tokenAutoRefresh?.enabled || false);
        setTokenAutoRefreshLastRunAt(data.tokenAutoRefresh?.lastRunAt || null);
        setTokenAutoRefreshStats(data.tokenAutoRefresh?.lastRunStats || {
          accountsChecked: 0,
          accountsRefreshed: 0,
          successCount: 0,
          failureCount: 0,
        });
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
        const tUrl = data.tunnel?.tunnelUrl || "";
        setTunnelUrl(tUrl);
        setTunnelPublicUrl(data.tunnel?.publicUrl || "");
        setTunnelEnabled(tEnabled);
        updateReachable(null, tunnelClientReachableRef, tunnelMissRef, setTunnelReachable, tunnelEverReachableRef, setTunnelEverReachable);

        const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
        const tsUrlVal = data.tailscale?.tunnelUrl || "";
        setTsUrl(tsUrlVal);
        setTsEnabled(tsEn);
        updateReachable(null, tsClientReachableRef, tsMissRef, setTsReachable, tsEverReachableRef, setTsEverReachable);
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    } finally {
      setTunnelChecking(false);
    }
  };

  const handleTunnelDashboardAccess = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tunnelDashboardAccess: value }),
      });
      if (res.ok) setTunnelDashboardAccess(value);
    } catch (error) {
      console.log("Error updating tunnelDashboardAccess:", error);
    }
  };

  const handleRequireApiKey = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireApiKey: value }),
      });
      if (res.ok) setRequireApiKey(value);
    } catch (error) {
      console.log("Error updating requireApiKey:", error);
    }
  };

  const handleTokenAutoRefreshToggle = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenAutoRefresh: {
            enabled: value,
            lastRunAt: tokenAutoRefreshLastRunAt,
            lastRunStats: tokenAutoRefreshStats,
          },
        }),
      });
      if (res.ok) {
        setTokenAutoRefreshEnabled(value);
        // Reload settings to get updated stats
        setTimeout(() => loadSettings(), 1000);
      }
    } catch (error) {
      console.log("Error updating tokenAutoRefresh:", error);
    }
  };

  const fetchData = async () => {
    try {
      const keysRes = await fetch("/api/keys");
      const keysData = await keysRes.json();
      if (keysRes.ok) {
        const keys = keysData.keys || [];
        setKeys(keys);
        // Fetch quota using batch approach
        await fetchAllKeyQuotas(keys);
      }
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  // Fetch and aggregate quota for all API keys in one optimized batch
  const fetchAllKeyQuotas = async (keys) => {
    try {
      // Set loading state for all keys
      const loadingState = {};
      keys.forEach(key => {
        loadingState[key.id] = {loading: true};
      });
      setKeyQuotas(loadingState);

      // Fetch connection assignments in one call
      const assignmentsRes = await fetch('/api/keys/credits');
      if (!assignmentsRes.ok) {
        console.log("Failed to fetch key credits");
        return;
      }

      const { assignments } = await assignmentsRes.json();

      // Process each key's quota
      for (const key of keys) {
        const connIds = assignments[key.id] || [];

        if (connIds.length === 0) {
          setKeyQuotas(prev => ({...prev, [key.id]: null}));
          continue;
        }

        // Fetch quota for each assigned connection
        const quotaPromises = connIds.map(connId =>
          fetch(`/api/usage/${connId}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        );
        const quotasData = await Promise.all(quotaPromises);

        // Aggregate credit across all connections
        let totalUsed = 0;
        let totalLimit = 0;
        let hasData = false;

        quotasData.forEach(quotaData => {
          if (!quotaData?.quotas) return;

          // Try common credit resource keys
          const credit = quotaData.quotas.credit || quotaData.quotas["0"];

          if (credit && credit.total !== undefined) {
            totalUsed += credit.used || 0;
            totalLimit += credit.total || 0;
            hasData = true;
          }
        });

        if (hasData) {
          setKeyQuotas(prev => ({
            ...prev,
            [key.id]: {
              used: totalUsed,
              total: totalLimit,
              loading: false
            }
          }));
        } else {
          setKeyQuotas(prev => ({...prev, [key.id]: null}));
        }
      }
    } catch (error) {
      console.log("Error fetching key quotas:", error);
      keys.forEach(key => {
        setKeyQuotas(prev => ({
          ...prev,
          [key.id]: {error: error.message, loading: false}
        }));
      });
    }
  };

  // u2500u2500u2500 Cloudflare Tunnel handlers
  // Ping tunnel health until reachable. Race multiple URLs (shortlink + direct) — 1 OK is enough.
  const pingTunnelHealth = async (...urls) => {
    setTunnelLoading(true);
    setTunnelProgress("Waiting for tunnel ready...");
    const targets = urls.filter(Boolean).map((u) => `${u}/api/health`);
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      const ok = await Promise.any(targets.map(async (h) => {
        const p = await fetch(h, { mode: "cors", cache: "no-store" });
        if (p.ok) return true;
        throw new Error("not ready");
      })).catch(() => false);
      if (ok) {
        setTunnelEnabled(true);
        setTunnelLoading(false);
        setTunnelProgress("");
        return true;
      }
      // Every 5 pings (~10s), check if backend process still alive
      if ((Date.now() - start) % 10000 < TUNNEL_PING_INTERVAL_MS) {
        try {
          const statusRes = await fetch("/api/tunnel/status");
          if (statusRes.ok) {
            const status = await statusRes.json();
            if (!status.tunnel?.enabled) {
              setTunnelStatus({ type: "error", message: "Tunnel process stopped unexpectedly." });
              setTunnelLoading(false);
              setTunnelProgress("");
              return false;
            }
          }
        } catch { /* ignore */ }
      }
    }
    setTunnelStatus({ type: "error", message: "Tunnel created but not reachable. Please try again." });
    setTunnelLoading(false);
    setTunnelProgress("");
    return false;
  };

  const handleEnableTunnel = async () => {
    setShowEnableTunnelModal(false);
    setTunnelLoading(true);
    setTunnelStatus(null);
    setTunnelProgress("Creating tunnel...");

    // Poll download progress while enable request is pending
    let polling = true;
    const pollProgress = async () => {
      while (polling) {
        try {
          const r = await fetch("/api/tunnel/status");
          if (r.ok) {
            const s = await r.json();
            if (s.download?.downloading) {
              setTunnelProgress(`Downloading cloudflared... ${s.download.progress}%`);
            } else if (polling) {
              setTunnelProgress("Creating tunnel...");
            }
          }
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    pollProgress();

    try {
      const res = await fetch("/api/tunnel/enable", { method: "POST" });
      polling = false;
      const data = await res.json();
      if (!res.ok) {
        setTunnelStatus({ type: "error", message: data.error || "Failed to enable tunnel" });
        return;
      }

      const url = data.tunnelUrl;
      if (!url) {
        setTunnelStatus({ type: "error", message: "No tunnel URL returned" });
        return;
      }

      setTunnelUrl(url);
      setTunnelPublicUrl(data.publicUrl || "");
      await pingTunnelHealth(data.publicUrl, url);
    } catch (error) {
      setTunnelStatus({ type: "error", message: error.message });
    } finally {
      polling = false;
      setTunnelLoading(false);
      setTunnelProgress("");
    }
  };

  const handleDisableTunnel = async () => {
    setTunnelLoading(true);
    setTunnelStatus(null);
    try {
      const res = await fetch("/api/tunnel/disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTunnelEnabled(false);
        setTunnelUrl("");
        setShowDisableTunnelModal(false);
        setTunnelStatus({ type: "success", message: "Tunnel disabled" });
      } else {
        setTunnelStatus({ type: "error", message: data.error || "Failed to disable tunnel" });
      }
    } catch (error) {
      setTunnelStatus({ type: "error", message: error.message });
    } finally {
      setTunnelLoading(false);
    }
  };

  // u2500u2500u2500 Tailscale handlers
  const checkTailscaleInstalled = async () => {
    setTsInstalled(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-check");
      if (res.ok) {
        const data = await res.json();
        setTsInstalled(data.installed);
        return data;
      }
    } catch { /* ignore */ }
    setTsInstalled(false);
    return { installed: false };
  };

  const handleInstallTailscale = async () => {
    setTsInstalling(true);
    setTsStatus(null);
    setTsInstallLog([]);
    try {
      const res = await fetch("/api/tunnel/tailscale-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword: tsSudoPassword }),
      });
      setTsSudoPassword("");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const lines = part.split("\n");
          let event = "progress";
          let data = null;
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            if (line.startsWith("data: ")) {
              try { data = JSON.parse(line.slice(6)); } catch { /* skip */ }
            }
          }
          if (!data) continue;
          if (event === "progress") {
            setTsInstallLog((prev) => [...prev.slice(-50), data.message]);
          } else if (event === "done") {
            setTsInstalled(true);
            setTsInstalling(false);
            setShowTsModal(false);
            handleConnectTailscale();
            return;
          } else if (event === "error") {
            setTsStatus({ type: "error", message: data.error || "Install failed" });
          }
        }
      }
    } catch (e) {
      setTsStatus({ type: "error", message: e.message });
    } finally {
      setTsInstalling(false);
    }
  };

  // Ping Tailscale health until reachable
  const pingTsHealth = async (url) => {
    setTsProgress("Waiting for Tailscale ready...");
    const healthUrl = `${url}/api/health`;
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      try {
        const ping = await fetch(healthUrl, { mode: "no-cors", cache: "no-store" });
        if (ping.ok || ping.type === "opaque") return true;
      } catch { /* not ready yet */ }
    }
    return false;
  };

  // Show inline login button instead of auto-opening popup (browsers block popups
  // opened after async work because the user gesture is lost).
  const requestUserAuth = (url, label) => {
    setTsAuthUrl(url);
    setTsAuthLabel(label);
  };

  const clearUserAuth = () => {
    setTsAuthUrl("");
    setTsAuthLabel("");
  };

  const handleConnectTailscale = async () => {
    setShowTsModal(false);
    setTsConnecting(true);
    setTsLoading(true);
    setTsStatus(null);
    setTsProgress("Connecting...");
    clearUserAuth();
    try {
      const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
      const data = await res.json();

      if (res.ok && data.success) {
        setTsUrl(data.tunnelUrl || "");
        const reachable = await pingTsHealth(data.tunnelUrl);
        setTsEnabled(true);
        setTsStatus(reachable ? null : { type: "warning", message: "Connected but not reachable yet." });
        return;
      }

      if (data.needsLogin && data.authUrl) {
        requestUserAuth(data.authUrl, "Open Login Page");
        setTsProgress("Login required — click \"Open Login Page\" to continue");
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const r2 = await fetch("/api/tunnel/tailscale-check");
            if (r2.ok) {
              const check = await r2.json();
              if (check.loggedIn) {
                clearUserAuth();
                setTsProgress("Starting funnel...");
                const res2 = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
                const data2 = await res2.json();
                if (res2.ok && data2.success) {
                  setTsUrl(data2.tunnelUrl || "");
                  const ok2 = await pingTsHealth(data2.tunnelUrl);
                  setTsEnabled(true);
                  setTsStatus(ok2 ? null : { type: "warning", message: "Connected but not reachable yet." });
                } else if (data2.funnelNotEnabled && data2.enableUrl) {
                  await pollFunnelEnable(data2.enableUrl);
                } else {
                  setTsStatus({ type: "error", message: data2.error || "Failed to start funnel" });
                }
                return;
              }
            }
          } catch { /* retry */ }
        }
        clearUserAuth();
        setTsStatus({ type: "error", message: "Login timed out. Please try again." });
        return;
      }

      if (data.funnelNotEnabled && data.enableUrl) {
        await pollFunnelEnable(data.enableUrl);
        return;
      }

      setTsStatus({ type: "error", message: data.error || "Failed to connect" });
    } catch (error) {
      setTsStatus({ type: "error", message: error.message });
    } finally {
      setTsLoading(false);
      setTsConnecting(false);
      setTsProgress("");
      clearUserAuth();
    }
  };

  const pollFunnelEnable = async (enableUrl) => {
    requestUserAuth(enableUrl, "Open Funnel Settings");
    setTsProgress("Click \"Open Funnel Settings\" to enable Funnel...");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
        const data = await res.json();
        if (res.ok && data.success) {
          clearUserAuth();
          setTsUrl(data.tunnelUrl || "");
          const ok3 = await pingTsHealth(data.tunnelUrl);
          setTsEnabled(true);
          setTsStatus(ok3 ? null : { type: "warning", message: "Connected but not reachable yet." });
          return;
        }
        if (data.funnelNotEnabled) continue;
        if (data.error) {
          clearUserAuth();
          setTsStatus({ type: "error", message: data.error });
          return;
        }
      } catch { /* retry */ }
    }
    clearUserAuth();
    setTsStatus({ type: "error", message: "Timed out waiting for Funnel to be enabled." });
  };

  const handleDisableTailscale = async () => {
    setTsLoading(true);
    setTsStatus(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTsEnabled(false);
        setTsUrl("");
        setShowDisableTsModal(false);
        setTsStatus({ type: "success", message: "Tailscale disabled" });
      } else {
        setTsStatus({ type: "error", message: data.error || "Failed to disable Tailscale" });
      }
    } catch (e) {
      setTsStatus({ type: "error", message: e.message });
    } finally {
      setTsLoading(false);
    }
  };

  const handleOpenTsModal = async () => {
    setTsStatus(null);
    setTsInstallLog([]);
    const data = await checkTailscaleInstalled();
    if (data?.installed && data?.hasCachedPassword) {
      handleConnectTailscale();
    } else {
      setShowTsModal(true);
    }
  };

  const handleCreateKey = async () => {
    if (!keyForm.name.trim()) return;

    try {
      const body = {
        name: keyForm.name,
        tokenLimit: keyForm.tokenLimit || null,
        requestLimit: keyForm.requestLimit || null,
        resetPeriod: keyForm.resetPeriod,
        customResetDays: keyForm.customResetDays || null,
        scopeType: keyForm.scopeType,
        allowedModels: keyForm.allowedModels.length > 0 ? keyForm.allowedModels : null,
        allowedCombos: keyForm.allowedCombos.length > 0 ? keyForm.allowedCombos : null,
        allocatedConnectionIds: keyForm.allocatedConnectionIds.length > 0 ? keyForm.allocatedConnectionIds : undefined,
      };

      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (res.ok) {
        setCreatedKey(data.key);
        await fetchData();
        // Reset form
        setKeyForm({
          name: "",
          tokenLimit: null,
          requestLimit: null,
          resetPeriod: "monthly",
          customResetDays: null,
          scopeType: "global",
          allowedModels: [],
          allowedCombos: [],
          allocatedConnectionIds: [],
        });
        setShowAddModal(false);
      }
    } catch (error) {
      console.log("Error creating key:", error);
    }
  };

  const handleUpdateKey = async () => {
    if (!selectedKey || !keyForm.name.trim()) return;

    try {
      const body = {
        name: keyForm.name,
        tokenLimit: keyForm.tokenLimit || null,
        requestLimit: keyForm.requestLimit || null,
        resetPeriod: keyForm.resetPeriod,
        customResetDays: keyForm.customResetDays || null,
        scopeType: keyForm.scopeType,
        allowedModels: keyForm.allowedModels.length > 0 ? keyForm.allowedModels : null,
        allowedCombos: keyForm.allowedCombos.length > 0 ? keyForm.allowedCombos : null,
        allocatedConnectionIds: keyForm.allocatedConnectionIds,
      };

      const res = await fetch(`/api/keys/${selectedKey.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        await fetchData();
        setShowEditModal(false);
        setSelectedKey(null);
      }
    } catch (error) {
      console.log("Error updating key:", error);
    }
  };

  const handleDeleteKey = async (id) => {
    setConfirmState({
      title: "Delete API Key",
      message: "Delete this API key?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys(keys.filter((k) => k.id !== id));
            setVisibleKeys(prev => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        } catch (error) {
          console.log("Error deleting key:", error);
        }
      }
    });
  };

  const handleToggleKey = async (id, isActive) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, isActive } : k));
      }
    } catch (error) {
      console.log("Error toggling key:", error);
    }
  };

  const maskKey = (fullKey) => {
    if (!fullKey || fullKey.length <= 10) return fullKey || "";
    return fullKey.slice(0, 6) + "•".repeat(fullKey.length - 10) + fullKey.slice(-4);
  };

  // Fetch available connections for this API key
  const fetchAvailableConnections = async (apiKeyId) => {
    try {
      const url = apiKeyId
        ? `/api/connections/available?apiKeyId=${apiKeyId}`
        : `/api/connections/available`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setAvailableConnections(data.connections || []);
      }
    } catch (error) {
      console.log("Error fetching connections:", error);
    }
  };

  // Fetch data for model/combo select modals
  const fetchModalData = async () => {
    try {
      const [providersRes, aliasesRes, combosRes] = await Promise.all([
        fetch("/api/providers"),
        fetch("/api/models/alias"),
        fetch("/api/combos"),
      ]);
      if (providersRes.ok) {
        const providersData = await providersRes.json();
        setActiveProviders(providersData.connections || []);
      }
      if (aliasesRes.ok) {
        const aliasesData = await aliasesRes.json();
        setModelAliases(aliasesData.aliases || {});
      }
      if (combosRes.ok) {
        const combosData = await combosRes.json();
        setCombos((combosData.combos || []).filter(c => !c.kind || c.kind === "llm"));
      }
    } catch (error) {
      console.error("Error fetching modal data:", error);
    }
  };

  // Handlers for model/combo select
  const handleAddModel = (model) => {
    if (!keyForm.allowedModels.includes(model.value)) {
      setKeyForm({ ...keyForm, allowedModels: [...keyForm.allowedModels, model.value] });
    }
  };

  const handleRemoveModel = (modelValue) => {
    setKeyForm({ ...keyForm, allowedModels: keyForm.allowedModels.filter(m => m !== modelValue) });
  };

  const handleAddCombo = (comboName) => {
    if (!keyForm.allowedCombos.includes(comboName)) {
      setKeyForm({ ...keyForm, allowedCombos: [...keyForm.allowedCombos, comboName] });
    }
  };

  const handleRemoveCombo = (comboName) => {
    setKeyForm({ ...keyForm, allowedCombos: keyForm.allowedCombos.filter(c => c !== comboName) });
  };

  const handleAddConnection = (connectionId) => {
    if (!keyForm.allocatedConnectionIds.includes(connectionId)) {
      setKeyForm({
        ...keyForm,
        allocatedConnectionIds: [...keyForm.allocatedConnectionIds, connectionId]
      });
    }
  };

  const handleRemoveConnection = (connectionId) => {
    setKeyForm({
      ...keyForm,
      allocatedConnectionIds: keyForm.allocatedConnectionIds.filter(id => id !== connectionId)
    });
  };

  const handleToggleConnection = (connectionId) => {
    if (keyForm.allocatedConnectionIds.includes(connectionId)) {
      handleRemoveConnection(connectionId);
    } else {
      handleAddConnection(connectionId);
    }
  };

  const toggleProviderExpansion = (provider) => {
    setExpandedProviders(prev => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  const [baseUrl, setBaseUrl] = useState("/v1");

  // Hydration fix: Only access window on client side
  useEffect(() => {
    if (typeof window !== "undefined") {
      setBaseUrl(`${window.location.origin}/v1`);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const currentEndpoint = baseUrl;

  return (
    <div className="flex flex-col gap-8">
      {/* Endpoint Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">api</span>
          API Endpoint
        </h2>

        {/* Endpoint rows */}
        <div className="flex flex-col gap-2">
          {/* Local */}
          <EndpointRow
            label="Local"
            url={currentEndpoint}
            copyId="local_url"
            copied={copied}
            onCopy={copy}
          />
          {/* Cloudflare Tunnel */}
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] text-center ${
              tunnelEnabled ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"
            }`}>Tunnel</span>
            {tunnelEnabled && !tunnelLoading && tunnelReachable ? (
              <>
                <Input value={`${tunnelPublicUrl || tunnelUrl}/v1`} readOnly className="flex-1 font-mono text-sm" />
                <button
                  onClick={() => copy(`${tunnelPublicUrl || tunnelUrl}/v1`, "tunnel_url")}
                  className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-[18px]">{copied === "tunnel_url" ? "check" : "content_copy"}</span>
                </button>
                <button
                  onClick={() => setShowDisableTunnelModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tunnel"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tunnelEnabled && !tunnelLoading && !tunnelReachable ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-500/5 text-sm text-amber-600 dark:text-amber-400">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tunnelEverReachable ? "Tunnel reconnecting..." : "Tunnel checking..."}
                </div>
                <button
                  onClick={() => setShowDisableTunnelModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tunnel"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tunnelLoading ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-input text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tunnelProgress || "Creating tunnel..."}
                </div>
                <button
                  onClick={() => { setTunnelLoading(false); setTunnelProgress(""); }}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Stop"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tunnelStatus?.type === "error" ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-red-300 dark:border-red-800 bg-red-500/5 text-sm text-red-600 dark:text-red-400">
                  <span className="material-symbols-outlined text-sm">error</span>
                  {tunnelStatus.message}
                </div>
                <Button size="sm" icon="cloud_upload" onClick={() => setShowEnableTunnelModal(true)}>Enable</Button>
              </>
            ) : tunnelChecking ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-input text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  Checking...
                </div>
                <button
                  onClick={() => setTunnelChecking(false)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Stop"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : (
              <Button
                size="sm"
                icon="cloud_upload"
                onClick={() => {
                  if (isLoginUnsafe) {
                    setTunnelStatus({ type: "error", message: `Security required: ${unsafeReason}` });
                    return;
                  }
                  if (!requireApiKey) {
                    setTunnelStatus({ type: "error", message: "Security required: Enable \"Require API key\" before activating the tunnel." });
                    return;
                  }
                  setShowEnableTunnelModal(true);
                }}
              >
                Enable
              </Button>
            )}
          </div>
          {/* Tailscale */}
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] text-center ${
              tsEnabled ? "bg-primary/10 text-primary" : "bg-surface-2 text-text-muted"
            }`}>Tailscale</span>
            {tsEnabled && !tsLoading && tsReachable ? (
              <>
                <Input value={`${tsUrl}/v1`} readOnly className="flex-1 font-mono text-sm" />
                <button
                  onClick={() => copy(`${tsUrl}/v1`, "ts_url")}
                  className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-[18px]">{copied === "ts_url" ? "check" : "content_copy"}</span>
                </button>
                <button
                  onClick={() => setShowDisableTsModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tailscale"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tsEnabled && !tsLoading && !tsReachable ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-500/5 text-sm text-amber-600 dark:text-amber-400">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tsEverReachable ? "Tailscale reconnecting..." : "Tailscale checking..."}
                </div>
                <button
                  onClick={() => setShowDisableTsModal(true)}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Disable Tailscale"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : (tsLoading || tsConnecting) ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-border bg-input text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                  {tsProgress || "Connecting..."}
                </div>
                {tsAuthUrl && (
                  <Button
                    size="sm"
                    icon="open_in_new"
                    onClick={() => window.open(tsAuthUrl, "tailscale_auth", "width=600,height=700,noopener,noreferrer")}
                  >
                    {tsAuthLabel || "Open"}
                  </Button>
                )}
                <button
                  onClick={() => { setTsLoading(false); setTsConnecting(false); setTsProgress(""); clearUserAuth(); }}
                  className="p-2 hover:bg-red-500/10 rounded text-red-500 transition-colors shrink-0"
                  title="Stop"
                >
                  <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
                </button>
              </>
            ) : tsStatus?.type === "error" ? (
              <>
                <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded border border-red-300 dark:border-red-800 bg-red-500/5 text-sm text-red-600 dark:text-red-400">
                  <span className="material-symbols-outlined text-sm">error</span>
                  {tsStatus.message}
                </div>
                <Button size="sm" icon="vpn_lock" onClick={handleOpenTsModal}>Enable</Button>
              </>
            ) : (
              <Button
                size="sm"
                icon="vpn_lock"
                onClick={() => {
                  if (isLoginUnsafe) {
                    setTsStatus({ type: "error", message: `Security required: ${unsafeReason}` });
                    return;
                  }
                  handleOpenTsModal();
                }}
                className="bg-linear-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 text-white!"
              >
                Enable
              </Button>
            )}
          </div>
        </div>

        {/* Pre-enable security gate banner */}
        {isLoginUnsafe && !tunnelEnabled && !tsEnabled && (
          <div className="mt-4">
            <SecurityWarning
              message={unsafeReason}
              action={{ label: "Open settings", href: "/dashboard/profile" }}
            />
          </div>
        )}

        {/* Security warnings when tunnel or tailscale is active */}
        {(tunnelEnabled || tsEnabled) && (
          <div className="mt-4 flex flex-col gap-2">
            {!requireApiKey && (
              <SecurityWarning
                message="Require API key is disabled — your endpoint is publicly accessible without authentication."
                action={{ label: "Enable", href: "#require-api-key" }}
              />
            )}
            {(!requireLogin || !hasPassword) && (
              <SecurityWarning
                message={
                  !requireLogin
                    ? "Require login is disabled — anyone can access your dashboard via tunnel."
                    : "Dashboard uses the default password — change it in Profile settings."
                }
                action={{
                  label: !requireLogin ? "Enable" : "Change password",
                  href: "/dashboard/profile",
                }}
              />
            )}
          </div>
        )}

        {/* Tunnel dashboard access option */}
        {(tunnelEnabled || tsEnabled) && (
          <div className="mt-4 pt-4 border-t border-border flex items-center gap-3">
            <Toggle
              checked={tunnelDashboardAccess}
              onChange={() => handleTunnelDashboardAccess(!tunnelDashboardAccess)}
            />
            <div className="flex items-center gap-1.5">
              <p className="font-medium text-sm">Allow dashboard access via tunnel</p>
              <Tooltip text="When enabled, the dashboard can be accessed through your tunnel or Tailscale URL (login still required). When disabled, dashboard access via tunnel/Tailscale is completely blocked." />
            </div>
          </div>
        )}
      </Card>

      {/* Token Auto-Refresh */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">autorenew</span>
            Token Auto-Refresh
          </h2>
        </div>

        <div className="flex items-center justify-between pb-4 mb-4 border-b border-border">
          <div>
            <p className="font-medium">Automatic Token Refresh</p>
            <p className="text-sm text-text-muted">
              Automatically refresh OAuth tokens before they expire (runs every 10 minutes, 20% lifetime threshold)
            </p>
          </div>
          <Toggle
            checked={tokenAutoRefreshEnabled}
            onChange={() => handleTokenAutoRefreshToggle(!tokenAutoRefreshEnabled)}
          />
        </div>

        {tokenAutoRefreshEnabled && (
          <div className="space-y-3">
            <div className="text-sm">
              <p className="font-medium mb-3 flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">info</span>
                Status
              </p>
              
              <div className="bg-surface-hover p-3 rounded-lg mb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-text-muted text-xs">Last Run</p>
                    <p className="font-mono text-xs mt-0.5">
                      {tokenAutoRefreshLastRunAt 
                        ? new Date(tokenAutoRefreshLastRunAt).toLocaleString()
                        : 'Not yet run'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-text-muted text-xs">Schedule</p>
                    <p className="text-xs mt-0.5">Every 10 minutes</p>
                  </div>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div className="bg-surface-hover p-3 rounded-lg">
                  <p className="text-text-muted text-xs mb-1">Accounts Checked</p>
                  <p className="text-2xl font-semibold">{tokenAutoRefreshStats.accountsChecked}</p>
                </div>
                <div className="bg-surface-hover p-3 rounded-lg">
                  <p className="text-text-muted text-xs mb-1">Accounts Refreshed</p>
                  <p className="text-2xl font-semibold">{tokenAutoRefreshStats.accountsRefreshed}</p>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-green-500/10 border border-green-500/20 p-3 rounded-lg flex items-center gap-2">
                  <span className="material-symbols-outlined text-green-500 text-[20px]">check_circle</span>
                  <div>
                    <p className="text-text-muted text-xs">Success</p>
                    <p className="text-lg font-semibold text-green-500">{tokenAutoRefreshStats.successCount}</p>
                  </div>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 p-3 rounded-lg flex items-center gap-2">
                  <span className="material-symbols-outlined text-red-500 text-[20px]">error</span>
                  <div>
                    <p className="text-text-muted text-xs">Failed</p>
                    <p className="text-lg font-semibold text-red-500">{tokenAutoRefreshStats.failureCount}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* API Keys */}
      <Card id="require-api-key">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">vpn_key</span>
            API Keys
          </h2>
          <Button icon="add" onClick={() => setShowAddModal(true)}>
            Create Key
          </Button>
        </div>

        <div className="flex items-center justify-between pb-4 mb-4 border-b border-border">
          <div>
            <p className="font-medium">Require API key</p>
            <p className="text-sm text-text-muted">
              Requests without a valid key will be rejected
            </p>
          </div>
          <Toggle
            checked={requireApiKey}
            onChange={() => handleRequireApiKey(!requireApiKey)}
          />
        </div>

        {isRemoteHost && !requireApiKey && (
          <div className="mb-4 -mt-2">
            <SecurityWarning message="Endpoint is exposed without an API key." />
          </div>
        )}

        {keys.length === 0 ? (
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">vpn_key</span>
            </div>
            <p className="text-text-main font-medium mb-1">No API keys yet</p>
            <p className="text-sm text-text-muted mb-4">Create your first API key to get started</p>
            <Button icon="add" onClick={() => setShowAddModal(true)}>
              Create Key
            </Button>
          </div>
        ) : (
          <div className="flex flex-col">
            {keys.map((key) => (
              <div
                key={key.id}
                className={`group flex items-center justify-between py-3 border-b border-black/10 dark:border-white/10 last:border-b-0 ${key.isActive === false ? "opacity-60" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{key.name}</p>
                    {key.scopeType === 'restricted' && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1 shrink-0">
                        <span className="material-symbols-outlined text-[14px]">lock</span>
                        <span className="hidden sm:inline">Restricted to specific models</span>
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="text-xs text-text-muted font-mono">
                      {visibleKeys.has(key.id) ? key.key : maskKey(key.key)}
                    </code>
                    <button
                      onClick={() => toggleKeyVisibility(key.id)}
                      className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                      title={visibleKeys.has(key.id) ? "Hide key" : "Show key"}
                    >
                      <span className="material-symbols-outlined text-[14px]">
                        {visibleKeys.has(key.id) ? "visibility_off" : "visibility"}
                      </span>
                    </button>
                    <button
                      onClick={() => copy(key.key, key.id)}
                      className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                    >
                      <span className="material-symbols-outlined text-[14px]">
                        {copied === key.id ? "check" : "content_copy"}
                      </span>
                    </button>
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                    {(key.tokenLimit || key.requestLimit) && key.resetAt && (
                      <> | Resets {new Date(key.resetAt).toLocaleDateString()}</>
                    )}
                  </p>
                  {key.isActive === false && (
                    <p className="text-xs text-orange-500 mt-1">Paused</p>
                  )}

                  {/* Usage stats - combined horizontal layout */}
                  {(key.tokenLimit || key.requestLimit || (keyQuotas[key.id] && !keyQuotas[key.id].loading && !keyQuotas[key.id].error && keyQuotas[key.id].total > 0)) && (
                    <div className="mt-2 flex gap-3">
                      {key.tokenLimit && (
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between text-[10px] mb-0.5">
                            <span className="text-text-muted">Tokens</span>
                            <span className={`font-medium ${(key.tokensUsed / key.tokenLimit) > 0.9 ? 'text-red-500' : (key.tokensUsed / key.tokenLimit) > 0.7 ? 'text-amber-500' : 'text-green-500'}`}>
                              {key.tokensUsed.toLocaleString()}/{key.tokenLimit.toLocaleString()}
                            </span>
                          </div>
                          <div className="h-1 w-full bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all ${(key.tokensUsed / key.tokenLimit) > 0.9 ? 'bg-red-500' : (key.tokensUsed / key.tokenLimit) > 0.7 ? 'bg-amber-500' : 'bg-green-500'}`}
                              style={{ width: `${Math.min(100, (key.tokensUsed / key.tokenLimit) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {key.requestLimit && (
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between text-[10px] mb-0.5">
                            <span className="text-text-muted">Requests</span>
                            <span className={`font-medium ${(key.requestsUsed / key.requestLimit) > 0.9 ? 'text-red-500' : (key.requestsUsed / key.requestLimit) > 0.7 ? 'text-amber-500' : 'text-green-500'}`}>
                              {key.requestsUsed.toLocaleString()}/{key.requestLimit.toLocaleString()}
                            </span>
                          </div>
                          <div className="h-1 w-full bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all ${(key.requestsUsed / key.requestLimit) > 0.9 ? 'bg-red-500' : (key.requestsUsed / key.requestLimit) > 0.7 ? 'bg-amber-500' : 'bg-green-500'}`}
                              style={{ width: `${Math.min(100, (key.requestsUsed / key.requestLimit) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {keyQuotas[key.id] && !keyQuotas[key.id].loading && !keyQuotas[key.id].error && keyQuotas[key.id].total > 0 && (
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between text-[10px] mb-0.5">
                            <span className="text-text-muted">Credit</span>
                            <span className={`font-medium ${
                              (keyQuotas[key.id].used / keyQuotas[key.id].total) > 0.7
                                ? 'text-red-500'
                                : (keyQuotas[key.id].used / keyQuotas[key.id].total) > 0.3
                                  ? 'text-amber-500'
                                  : 'text-green-500'
                            }`}>
                              {keyQuotas[key.id].used.toLocaleString()}/{keyQuotas[key.id].total.toLocaleString()}
                            </span>
                          </div>
                          <div className="h-1 w-full bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all ${
                                (keyQuotas[key.id].used / keyQuotas[key.id].total) > 0.7
                                  ? 'bg-red-500'
                                  : (keyQuotas[key.id].used / keyQuotas[key.id].total) > 0.3
                                    ? 'bg-amber-500'
                                    : 'bg-green-500'
                              }`}
                              style={{ width: `${Math.min(100, (keyQuotas[key.id].used / keyQuotas[key.id].total) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      // Open modal immediately for better UX
                      setSelectedKey(key);
                      setShowEditModal(true);

                      // Set initial form with empty connections (will load async)
                      setKeyForm({
                        name: key.name,
                        tokenLimit: key.tokenLimit,
                        requestLimit: key.requestLimit,
                        resetPeriod: key.resetPeriod || 'monthly',
                        customResetDays: key.customResetDays,
                        scopeType: key.scopeType || 'global',
                        allowedModels: key.allowedModels || [],
                        allowedCombos: key.allowedCombos || [],
                        allocatedConnectionIds: [], // Will be populated below
                      });

                      // Fetch data in background (modal already open)
                      fetchModalData();
                      fetchAvailableConnections(key.id);

                      // Fetch only assigned connections for this key (not all 2k)
                      try {
                        const connRes = await fetch(`/api/connections?assignedToApiKeyId=${key.id}`);
                        if (connRes.ok) {
                          const connData = await connRes.json();
                          const allocated = connData.connections.map(c => c.id);

                          // Update form with allocated connections
                          setKeyForm(prev => ({
                            ...prev,
                            allocatedConnectionIds: allocated,
                          }));
                        }
                      } catch (error) {
                        console.log("Error fetching allocated connections:", error);
                      }
                    }}
                    className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                    title="Edit key"
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <Toggle
                    size="sm"
                    checked={key.isActive ?? true}
                    onChange={(checked) => {
                      if (key.isActive && !checked) {
                        setConfirmState({
                          title: "Pause API Key",
                          message: `Pause API key "${key.name}"?\n\nThis key will stop working immediately but can be resumed later.`,
                          onConfirm: async () => {
                            setConfirmState(null);
                            handleToggleKey(key.id, checked);
                          }
                        });
                      } else {
                        handleToggleKey(key.id, checked);
                      }
                    }}
                    title={key.isActive ? "Pause key" : "Resume key"}
                  />
                  <button
                    onClick={() => handleDeleteKey(key.id)}
                    className="p-2 hover:bg-red-500/10 rounded text-red-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        onClose={() => {
          setShowAddModal(false);
          setKeyForm({
            name: "",
            tokenLimit: null,
            requestLimit: null,
            resetPeriod: "monthly",
            customResetDays: null,
            scopeType: "global",
            allowedModels: [],
            allowedCombos: [],
            allocatedConnectionIds: [],
          });
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
            <Input
              label="Key Name"
              value={keyForm.name}
              onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })}
              placeholder="Production Key"
            />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Token Limit (optional)"
              type="number"
              value={keyForm.tokenLimit || ""}
              onChange={(e) => setKeyForm({ ...keyForm, tokenLimit: e.target.value ? parseInt(e.target.value) : null })}
              placeholder="e.g. 1000000"
            />
            <Input
              label="Request Limit (optional)"
              type="number"
              value={keyForm.requestLimit || ""}
              onChange={(e) => setKeyForm({ ...keyForm, requestLimit: e.target.value ? parseInt(e.target.value) : null })}
              placeholder="e.g. 10000"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1">Reset Period</label>
              <select
                value={keyForm.resetPeriod}
                onChange={(e) => setKeyForm({ ...keyForm, resetPeriod: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
              >
                <option value="daily">Daily</option>
                <option value="monthly">Monthly</option>
                <option value="custom">Custom</option>
                <option value="never">Never</option>
              </select>
            </div>
            {keyForm.resetPeriod === 'custom' && (
              <Input
                label="Custom Reset Days"
                type="number"
                value={keyForm.customResetDays || ""}
                onChange={(e) => setKeyForm({ ...keyForm, customResetDays: e.target.value ? parseInt(e.target.value) : null })}
                placeholder="e.g. 7"
              />
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-text-main mb-1">Access Scope</label>
            <select
              value={keyForm.scopeType}
              onChange={(e) => setKeyForm({ ...keyForm, scopeType: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
            >
              <option value="global">Global (all models)</option>
              <option value="restricted">Restricted (specific models/combos)</option>
            </select>
          </div>

          {keyForm.scopeType === 'restricted' && (
            <>
              <div>
                <label className="block text-sm font-medium text-text-main mb-1.5">Allowed Models</label>
                {keyForm.allowedModels.length === 0 ? (
                  <div className="text-center py-3 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                    <p className="text-xs text-text-muted">No models selected</p>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 p-2 border border-border rounded-lg bg-surface-1 mb-2">
                    {keyForm.allowedModels.map((model) => (
                      <span
                        key={model}
                        className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary"
                      >
                        {model}
                        <button
                          onClick={() => handleRemoveModel(model)}
                          className="hover:bg-primary/20 rounded-sm p-0.5"
                        >
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => {
                    fetchModalData();
                    setShowModelSelect(true);
                  }}
                  type="button"
                  className="w-full mt-1 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                  Add Model
                </button>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-main mb-1.5">Allowed Combos</label>
                {keyForm.allowedCombos.length === 0 ? (
                  <div className="text-center py-3 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                    <p className="text-xs text-text-muted">No combos selected</p>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 p-2 border border-border rounded-lg bg-surface-1 mb-2">
                    {keyForm.allowedCombos.map((combo) => (
                      <span
                        key={combo}
                        className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary"
                      >
                        {combo}
                        <button
                          onClick={() => handleRemoveCombo(combo)}
                          className="hover:bg-primary/20 rounded-sm p-0.5"
                        >
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => {
                    fetchModalData();
                    setShowComboSelect(true);
                  }}
                  type="button"
                  className="w-full mt-1 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                  Add Combo
                </button>
              </div>
            </>
          )}

          {/* Connection Allocation Section */}
          <div>
            <label className="block text-sm font-medium text-text-main mb-1.5">
              Allocated Connections <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <p className="text-xs text-text-muted mb-2">
              Restrict this API key to specific provider connections. Leave empty to allow all connections.
            </p>
            {keyForm.allocatedConnectionIds.length === 0 ? (
              <div className="text-center py-3 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <p className="text-xs text-text-muted">No connections allocated</p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5 p-2 border border-border rounded-lg bg-surface-1 mb-2">
                {keyForm.allocatedConnectionIds.map((connId) => {
                  const conn = availableConnections.find(c => c.id === connId);
                  if (!conn) return null;

                  // Use nodeName for custom providers, fallback to customPrefix or provider ID
                  const providerDisplay = conn.providerSpecificData?.nodeName || conn.customPrefix || conn.provider;

                  return (
                    <span
                      key={connId}
                      className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-xs text-primary"
                    >
                      <span className="font-medium">{providerDisplay}</span>
                      <span className="text-text-muted">/</span>
                      <span className="font-mono">{conn.displayName || conn.name}</span>
                      <button
                        onClick={() => handleRemoveConnection(connId)}
                        className="hover:bg-primary/20 rounded-sm p-0.5"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <button
              onClick={() => {
                fetchAvailableConnections();
                setShowConnectionSelect(true);
              }}
              type="button"
              className="w-full mt-1 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Select Connections
            </button>
          </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleCreateKey} fullWidth disabled={!keyForm.name.trim()}>
              Create
            </Button>
            <Button
              onClick={() => {
                setShowAddModal(false);
                setKeyForm({
                  name: "",
                  tokenLimit: null,
                  requestLimit: null,
                  resetPeriod: "monthly",
                  customResetDays: null,
                  scopeType: "global",
                  allowedModels: [],
                  allowedCombos: [],
                  allocatedConnectionIds: [],
                });
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit Key Modal */}
      <Modal
        isOpen={showEditModal}
        title="Edit API Key"
        onClose={() => {
          setShowEditModal(false);
          setSelectedKey(null);
          setKeyForm({
            name: "",
            tokenLimit: null,
            requestLimit: null,
            resetPeriod: "monthly",
            customResetDays: null,
            scopeType: "global",
            allowedModels: [],
            allowedCombos: [],
            allocatedConnectionIds: [],
          });
        }}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
            <Input
              label="Key Name"
              value={keyForm.name}
              onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })}
              placeholder="Production Key"
            />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Token Limit (optional)"
              type="number"
              value={keyForm.tokenLimit || ""}
              onChange={(e) => setKeyForm({ ...keyForm, tokenLimit: e.target.value ? parseInt(e.target.value) : null })}
              placeholder="e.g. 1000000"
            />
            <Input
              label="Request Limit (optional)"
              type="number"
              value={keyForm.requestLimit || ""}
              onChange={(e) => setKeyForm({ ...keyForm, requestLimit: e.target.value ? parseInt(e.target.value) : null })}
              placeholder="e.g. 10000"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1">Reset Period</label>
              <select
                value={keyForm.resetPeriod}
                onChange={(e) => setKeyForm({ ...keyForm, resetPeriod: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
              >
                <option value="daily">Daily</option>
                <option value="monthly">Monthly</option>
                <option value="custom">Custom</option>
                <option value="never">Never</option>
              </select>
            </div>
            {keyForm.resetPeriod === 'custom' && (
              <Input
                label="Custom Reset Days"
                type="number"
                value={keyForm.customResetDays || ""}
                onChange={(e) => setKeyForm({ ...keyForm, customResetDays: e.target.value ? parseInt(e.target.value) : null })}
                placeholder="e.g. 7"
              />
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-text-main mb-1">Access Scope</label>
            <select
              value={keyForm.scopeType}
              onChange={(e) => setKeyForm({ ...keyForm, scopeType: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
            >
              <option value="global">Global (all models)</option>
              <option value="restricted">Restricted (specific models/combos)</option>
            </select>
          </div>

          {keyForm.scopeType === 'restricted' && (
            <>
              <div>
                <label className="block text-sm font-medium text-text-main mb-1.5">Allowed Models</label>
                {keyForm.allowedModels.length === 0 ? (
                  <div className="text-center py-3 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                    <p className="text-xs text-text-muted">No models selected</p>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 p-2 border border-border rounded-lg bg-surface-1 mb-2">
                    {keyForm.allowedModels.map((model) => (
                      <span
                        key={model}
                        className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary"
                      >
                        {model}
                        <button
                          onClick={() => handleRemoveModel(model)}
                          className="hover:bg-primary/20 rounded-sm p-0.5"
                        >
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => {
                    fetchModalData();
                    setShowModelSelect(true);
                  }}
                  type="button"
                  className="w-full mt-1 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                  Add Model
                </button>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-main mb-1.5">Allowed Combos</label>
                {keyForm.allowedCombos.length === 0 ? (
                  <div className="text-center py-3 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                    <p className="text-xs text-text-muted">No combos selected</p>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 p-2 border border-border rounded-lg bg-surface-1 mb-2">
                    {keyForm.allowedCombos.map((combo) => (
                      <span
                        key={combo}
                        className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary"
                      >
                        {combo}
                        <button
                          onClick={() => handleRemoveCombo(combo)}
                          className="hover:bg-primary/20 rounded-sm p-0.5"
                        >
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => {
                    fetchModalData();
                    setShowComboSelect(true);
                  }}
                  type="button"
                  className="w-full mt-1 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">add</span>
                  Add Combo
                </button>
              </div>
            </>
          )}

          {/* Connection Allocation Section */}
          <div>
            <label className="block text-sm font-medium text-text-main mb-1.5">
              Allocated Connections <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <p className="text-xs text-text-muted mb-2">
              Restrict this API key to specific provider connections. Leave empty to allow all connections.
            </p>
            {keyForm.allocatedConnectionIds.length === 0 ? (
              <div className="text-center py-3 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <p className="text-xs text-text-muted">No connections allocated</p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5 p-2 border border-border rounded-lg bg-surface-1 mb-2">
                {keyForm.allocatedConnectionIds.map((connId) => {
                  const conn = availableConnections.find(c => c.id === connId);
                  if (!conn) return null;

                  // Use nodeName for custom providers, fallback to customPrefix or provider ID
                  const providerDisplay = conn.providerSpecificData?.nodeName || conn.customPrefix || conn.provider;

                  return (
                    <span
                      key={connId}
                      className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-xs text-primary"
                    >
                      <span className="font-medium">{providerDisplay}</span>
                      <span className="text-text-muted">/</span>
                      <span className="font-mono">{conn.displayName || conn.name}</span>
                      <button
                        onClick={() => handleRemoveConnection(connId)}
                        className="hover:bg-primary/20 rounded-sm p-0.5"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <button
              onClick={() => {
                if (selectedKey) {
                  fetchAvailableConnections(selectedKey.id);
                }
                setShowConnectionSelect(true);
              }}
              type="button"
              className="w-full mt-1 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Select Connections
            </button>
          </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleUpdateKey} fullWidth disabled={!keyForm.name.trim()}>
              Update
            </Button>
            <Button
              onClick={() => {
                setShowEditModal(false);
                setSelectedKey(null);
                setKeyForm({
                  name: "",
                  tokenLimit: null,
                  requestLimit: null,
                  resetPeriod: "monthly",
                  customResetDays: null,
                  scopeType: "global",
                  allowedModels: [],
                  allowedCombos: [],
                  allocatedConnectionIds: [],
                });
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Created Key Modal */}
      <Modal
        isOpen={!!createdKey}
        title="API Key Created"
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              This is the only time you will see this key. Store it securely.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 font-mono text-sm"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Enable Tunnel Modal */}
      <Modal
        isOpen={showEnableTunnelModal}
        title="Enable Tunnel"
        onClose={() => setShowEnableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-surface-2 border border-border-subtle rounded-lg p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-primary">cloud_upload</span>
              <div>
                <p className="text-sm text-text-main font-medium mb-1">
                  Cloudflare Tunnel
                </p>
                <p className="text-sm text-text-muted">
                  Expose your local 9Router to the internet. No port forwarding, no static IP needed. Share endpoint URL with your team or use it in Cursor, Cline, and other AI tools from anywhere.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {TUNNEL_BENEFITS.map((benefit) => (
              <div key={benefit.title} className="flex flex-col items-center text-center p-3 rounded-lg bg-sidebar/50">
                <span className="material-symbols-outlined text-xl text-primary mb-1">{benefit.icon}</span>
                <p className="text-xs font-semibold">{benefit.title}</p>
                <p className="text-xs text-text-muted">{benefit.desc}</p>
              </div>
            ))}
          </div>

          <p className="text-xs text-text-muted">
            Requires outbound port 7844 (TCP/UDP). Connection may take 10-30s.
          </p>

          <div className="flex gap-2">
            <Button onClick={handleEnableTunnel} fullWidth>
              Start Tunnel
            </Button>
            <Button onClick={() => setShowEnableTunnelModal(false)} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Disable Cloudflare Tunnel Modal */}
      <Modal
        isOpen={showDisableTunnelModal}
        title="Disable Tunnel"
        onClose={() => !tunnelLoading && setShowDisableTunnelModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">The Cloudflare tunnel will be disconnected. Remote access via tunnel URL will stop working.</p>
          <div className="flex gap-2">
            <Button onClick={handleDisableTunnel} fullWidth disabled={tunnelLoading} variant="danger">
              {tunnelLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button onClick={() => setShowDisableTunnelModal(false)} variant="ghost" fullWidth disabled={tunnelLoading}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Tailscale Modal */}
      <Modal
        isOpen={showTsModal}
        title="Tailscale Funnel"
        onClose={() => { if (!tsInstalling) { setShowTsModal(false); setTsSudoPassword(""); setTsStatus(null); } }}
      >
        <div className="flex flex-col gap-4">
          {/* Checking state */}
          {tsInstalled === null && (
            <p className="text-sm text-text-muted flex items-center gap-2">
              <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              Checking...
            </p>
          )}

          {/* Not installed */}
          {tsInstalled === false && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">Tailscale is not installed. Install it to enable Funnel.</p>
              <div className="flex gap-2">
                <Button onClick={handleInstallTailscale} fullWidth>
                  Install Tailscale
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>Cancel</Button>
              </div>
            </div>
          )}

          {/* Installing with progress log */}
          {tsInstalling && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm text-text-muted">
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
                Installing Tailscale...
              </div>
              {tsInstallLog.length > 0 && (
                <div ref={tsLogRef} className="bg-black/5 dark:bg-white/5 rounded p-2 max-h-40 overflow-y-auto font-mono text-xs text-text-muted">
                  {tsInstallLog.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Installed: show Connect button */}
          {tsInstalled === true && !tsInstalling && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                Tailscale installed
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => handleConnectTailscale()}
                  fullWidth
                >
                  Connect
                </Button>
                <Button onClick={() => setShowTsModal(false)} variant="ghost" fullWidth>Cancel</Button>
              </div>
            </div>
          )}

          {tsStatus && <StatusAlert status={tsStatus} />}
        </div>
      </Modal>

      {/* Disable Tailscale Modal */}
      <Modal
        isOpen={showDisableTsModal}
        title="Disable Tailscale"
        onClose={() => !tsLoading && setShowDisableTsModal(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">Tailscale Funnel will be stopped. Remote access via Tailscale URL will stop working.</p>
          <div className="flex gap-2">
            <Button onClick={handleDisableTailscale} fullWidth disabled={tsLoading} variant="danger">
              {tsLoading ? "Disabling..." : "Disable"}
            </Button>
            <Button onClick={() => setShowDisableTsModal(false)} variant="ghost" fullWidth disabled={tsLoading}>Cancel</Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />

      {/* Model Select Modal */}
      <ModelSelectModal
        isOpen={showModelSelect}
        onClose={() => setShowModelSelect(false)}
        onSelect={handleAddModel}
        onDeselect={(model) => handleRemoveModel(model.value)}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title="Select Models"
        addedModelValues={keyForm.allowedModels}
        closeOnSelect={false}
      />

      {/* Combo Select Modal */}
      <Modal
        isOpen={showComboSelect}
        onClose={() => setShowComboSelect(false)}
        title="Select Combos"
      >
        <div className="flex flex-col gap-3">
          {combos.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-4">No combos available</p>
          ) : (
            <div className="flex flex-col gap-1 max-h-[400px] overflow-y-auto">
              {combos.map((combo) => {
                const isSelected = keyForm.allowedCombos.includes(combo.name);
                return (
                  <button
                    key={combo.name}
                    onClick={() => {
                      if (isSelected) {
                        handleRemoveCombo(combo.name);
                      } else {
                        handleAddCombo(combo.name);
                      }
                    }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                      isSelected
                        ? "bg-primary/10 text-primary border border-primary/30"
                        : "hover:bg-surface-2 border border-transparent"
                    }`}
                  >
                    <span className={`material-symbols-outlined text-[18px] ${isSelected ? "text-primary" : "text-text-muted"}`}>
                      {isSelected ? "check_box" : "check_box_outline_blank"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <code className="font-mono text-sm">{combo.name}</code>
                      {combo.models && combo.models.length > 0 && (
                        <p className="text-xs text-text-muted truncate">
                          {combo.models.slice(0, 3).join(", ")}
                          {combo.models.length > 3 && ` +${combo.models.length - 3} more`}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <Button onClick={() => setShowComboSelect(false)} variant="ghost" fullWidth>
            Close
          </Button>
        </div>
      </Modal>

      {/* Connection Select Modal */}
      <Modal
        isOpen={showConnectionSelect}
        onClose={() => {
          setShowConnectionSelect(false);
          setConnectionSearchQuery("");
        }}
        title="Select Connections"
      >
        <div className="flex flex-col gap-3">
          <Input
            placeholder="Search by name or provider..."
            value={connectionSearchQuery}
            onChange={(e) => setConnectionSearchQuery(e.target.value)}
          />

          {(() => {
            // Client-safe model parser (no server dependencies)
            const parseModelProvider = (modelStr) => {
              if (!modelStr || typeof modelStr !== 'string') return null;

              // Format: provider/model or @provider/model
              const parts = modelStr.split('/');
              if (parts.length < 2) return null;

              let providerAlias = parts[0].toLowerCase();

              // Common alias mappings (must match server provider IDs)
              const aliasMap = {
                'kr': 'kiro',
                '@cf': 'cloudflare',
                'cf': 'cloudflare',
                'ant': 'anthropic',
                'anthropic': 'anthropic',
                'oa': 'openai',
                'openai': 'openai',
                'goog': 'gemini-cli',
                'gemini': 'gemini-cli',
                'hf': 'huggingface',
                'huggingface': 'huggingface',
              };

              // Remove @ prefix if exists
              const cleanAlias = providerAlias.replace('@', '');

              return aliasMap[cleanAlias] || cleanAlias;
            };

            // Helper to extract providers from model strings
            const getProvidersFromModels = (modelStrings) => {
              const providers = new Set();
              for (const modelStr of modelStrings || []) {
                const provider = parseModelProvider(modelStr);
                if (provider) {
                  providers.add(provider);
                }
              }
              return Array.from(providers);
            };

            // Filter connections by allowed models scope
            let connectionsToShow = availableConnections;

            if (keyForm.scopeType === 'restricted' && (keyForm.allowedModels?.length > 0 || keyForm.allowedCombos?.length > 0)) {
              const allowedProviders = new Set();

              // Extract providers from allowed models
              if (keyForm.allowedModels?.length > 0) {
                const modelProviders = getProvidersFromModels(keyForm.allowedModels);
                modelProviders.forEach(p => allowedProviders.add(p));
              }

              // Known built-in provider IDs (not custom)
              const KNOWN_PROVIDERS = new Set([
                'kiro', 'cloudflare', 'anthropic', 'openai', 'gemini-cli',
                'huggingface', 'groq', 'cohere', 'mistral', 'perplexity',
                'deepseek', 'together', 'fireworks', 'replicate', 'codex'
              ]);

              // Check if user allows any custom provider models (server/*, etc.)
              const hasCustomModels = keyForm.allowedModels?.some(m => {
                const provider = parseModelProvider(m);
                return provider && !KNOWN_PROVIDERS.has(provider);
              });

              // Filter connections to only allowed providers
              if (allowedProviders.size > 0 || hasCustomModels) {
                connectionsToShow = availableConnections.filter(c => {
                  // Include if provider matches built-in allowed providers
                  if (allowedProviders.has(c.provider)) return true;

                  // For custom providers: match by customPrefix
                  if (hasCustomModels && c.customPrefix) {
                    // Check if this custom provider's prefix matches any allowed model prefix
                    return allowedProviders.has(c.customPrefix);
                  }

                  return false;
                });
              }
            }

            return connectionsToShow.length === 0 ? (
              <p className="text-sm text-text-muted text-center py-4">
                {keyForm.scopeType === 'restricted' && keyForm.allowedModels?.length > 0
                  ? "No connections available for allowed models"
                  : "No connections available"}
              </p>
            ) : (
              <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
                {/* Accordion by provider */}
                {Object.entries(
                  connectionsToShow
                    .filter(conn => {
                      if (!connectionSearchQuery) return true;
                      const query = connectionSearchQuery.toLowerCase();
                      return (
                        conn.name?.toLowerCase().includes(query) ||
                        conn.provider?.toLowerCase().includes(query) ||
                        conn.email?.toLowerCase().includes(query)
                      );
                    })
                    .reduce((acc, conn) => {
                      if (!acc[conn.provider]) acc[conn.provider] = [];
                      acc[conn.provider].push(conn);
                      return acc;
                    }, {})
                ).map(([provider, conns]) => {
                const isExpanded = expandedProviders.has(provider);
                const selectedCount = conns.filter(c => keyForm.allocatedConnectionIds.includes(c.id)).length;
                // Use nodeName for custom providers, fallback to provider ID
                const providerDisplayName = conns[0]?.providerSpecificData?.nodeName || provider;

                return (
                  <div key={provider} className="border border-border rounded-lg overflow-hidden">
                    {/* Accordion Header */}
                    <button
                      onClick={() => toggleProviderExpansion(provider)}
                      className="w-full flex items-center gap-2 px-3 py-2 bg-surface-1 hover:bg-surface-2 transition-colors text-left"
                    >
                      <span className="material-symbols-outlined text-[16px] text-text-muted">
                        {isExpanded ? "expand_more" : "chevron_right"}
                      </span>
                      <span className="text-sm font-semibold text-text-main uppercase tracking-wide flex-1">
                        {providerDisplayName}
                      </span>
                      <span className="text-xs text-text-muted">
                        {conns.length} connection{conns.length !== 1 ? 's' : ''}
                        {selectedCount > 0 && (
                          <span className="text-primary font-medium ml-1">
                            ({selectedCount} selected)
                          </span>
                        )}
                      </span>
                    </button>

                    {/* Accordion Content */}
                    {isExpanded && (
                      <div className="flex flex-col gap-1 p-2 bg-background max-h-[40vh] overflow-y-auto">
                        {conns.map((conn) => {
                          const isSelected = keyForm.allocatedConnectionIds.includes(conn.id);
                          const isAssignedToOther = conn.assignedToApiKeyId && conn.assignedToApiKeyId !== selectedKey?.id;

                          return (
                            <button
                              key={conn.id}
                              onClick={() => {
                                if (!isAssignedToOther) {
                                  handleToggleConnection(conn.id);
                                }
                              }}
                              disabled={isAssignedToOther}
                              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                                isSelected
                                  ? "bg-primary/10 text-primary border border-primary/30"
                                  : isAssignedToOther
                                  ? "opacity-50 cursor-not-allowed border border-transparent"
                                  : "hover:bg-surface-2 border border-transparent"
                              }`}
                            >
                              <span className={`material-symbols-outlined text-[18px] ${isSelected ? "text-primary" : "text-text-muted"}`}>
                                {isSelected ? "check_box" : "check_box_outline_blank"}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <code className="font-mono text-sm">{conn.displayName || conn.name}</code>
                                  {isAssignedToOther && (
                                    <span className="text-xs text-amber-600 dark:text-amber-400">(assigned)</span>
                                  )}
                                </div>
                                {conn.email && (
                                  <p className="text-xs text-text-muted truncate">{conn.email}</p>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
          })()}
          <Button onClick={() => {
            setShowConnectionSelect(false);
            setConnectionSearchQuery("");
          }} variant="ghost" fullWidth>
            Close
          </Button>
        </div>
      </Modal>
    </div>
  );
}


APIPageClient.propTypes = {
  machineId: PropTypes.string.isRequired,
};
