import { localApi } from "@/lib/local-functions";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const ACTIVE_CALL_MAX_AGE_MS = 2 * 60 * 60 * 1000;

type ActiveCallRow = {
  id: string;
  started_at: string;
  status: string;
  ended_at?: string | null;
} | null;

function resolveRecentActiveCall(candidate: ActiveCallRow) {
  if (!candidate?.started_at) return null;

  const startedAtMs = new Date(candidate.started_at).getTime();
  const isRecentActiveCall =
    Number.isFinite(startedAtMs) &&
    Date.now() - startedAtMs <= ACTIVE_CALL_MAX_AGE_MS;

  return isRecentActiveCall ? candidate : null;
}

/** Seconds left for the signed-in user (the server creates the 10 free minutes on first load). */
const loadMinuteBalanceSnapshot = (_userId: string, _email?: string) => localApi<{ availableSeconds: number; activeCall?: ActiveCallRow }>("/api/local/minutes", {});

export function useLiveMinuteBalance(userId?: string, isAdmin = false, userEmail?: string) {
  const [availableSeconds, setAvailableSeconds] = useState<number | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCallRow>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const loadBalance = async (targetUserId?: string) => {
    if (!targetUserId || isAdmin) {
      setAvailableSeconds(null);
      return;
    }

    try {
      const payload = await loadMinuteBalanceSnapshot(targetUserId, userEmail);
      setAvailableSeconds(Number(payload?.availableSeconds ?? 0));
    } catch (error) {
      console.warn("Failed to load minute balance", error);
    }
  };

  const loadActiveCall = async (targetUserId?: string) => {
    if (!targetUserId || isAdmin) {
      setActiveCall(null);
      return;
    }

    try {
      const payload = await loadMinuteBalanceSnapshot(targetUserId, userEmail);
      setActiveCall(resolveRecentActiveCall(payload?.activeCall ?? null));
    } catch (error) {
      console.warn("Failed to load active call", error);
      setActiveCall(null);
    }
  };

  useEffect(() => {
    if (!userId || isAdmin) {
      setAvailableSeconds(null);
      setActiveCall(null);
      setElapsedSeconds(0);
      return;
    }

    void loadBalance(userId);
    void loadActiveCall(userId);
  }, [userId, isAdmin, userEmail]);

  useEffect(() => {
    if (!userId || isAdmin) return;

    const balanceChannel = supabase
      .channel(`balance-realtime-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "user_minute_balances",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const next = payload.new as { available_seconds?: number } | null;
          setAvailableSeconds(next?.available_seconds ?? 0);
        },
      )
      .subscribe();

    const callLogsChannel = supabase
      .channel(`active-call-realtime-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "call_logs",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void loadActiveCall(userId);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(balanceChannel);
      void supabase.removeChannel(callLogsChannel);
    };
  }, [userId, isAdmin, userEmail]);

  useEffect(() => {
    if (!userId || isAdmin) return;

    const handleMinuteBalanceUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<{ availableSeconds?: number }>;
      if (typeof customEvent.detail?.availableSeconds === "number") {
        setAvailableSeconds(customEvent.detail.availableSeconds);
        return;
      }

      void loadBalance(userId);
      void loadActiveCall(userId);
    };

    window.addEventListener("minute-balance-updated", handleMinuteBalanceUpdate as EventListener);
    return () => {
      window.removeEventListener("minute-balance-updated", handleMinuteBalanceUpdate as EventListener);
    };
  }, [userId, isAdmin, userEmail]);

  useEffect(() => {
    if (!activeCall?.started_at || isAdmin) {
      setElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      const startedAtMs = new Date(activeCall.started_at).getTime();
      if (Number.isNaN(startedAtMs)) {
        setElapsedSeconds(0);
        return;
      }
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    };

    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [activeCall?.started_at, isAdmin]);

  useEffect(() => {
    if (!userId || isAdmin) return;

    const pollTimer = window.setInterval(() => {
      void loadBalance(userId);
      void loadActiveCall(userId);
    }, 10000);

    return () => {
      window.clearInterval(pollTimer);
    };
  }, [userId, isAdmin, userEmail]);

  const liveAvailableSeconds = useMemo(() => {
    if (isAdmin) return null;
    const base = Math.max(0, Number(availableSeconds ?? 0));
    if (!activeCall) return base;
    return Math.max(0, base - elapsedSeconds);
  }, [activeCall, availableSeconds, elapsedSeconds, isAdmin]);

  return {
    availableSeconds,
    liveAvailableSeconds,
    activeCall,
    refreshMinuteBalance: () => Promise.all([loadBalance(userId), loadActiveCall(userId)]),
  };
}
