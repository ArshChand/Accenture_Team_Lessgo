import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from '../api.js';

/**
 * The live queue, over a websocket where possible and HTTP polling where not.
 *
 * The fallback is not defensive boilerplate — it is a stated requirement. The
 * brief is explicit that hospitals differ enormously in technical maturity, and a
 * rural department behind a proxy that eats websocket upgrades must still see its
 * queue update. So the hook treats transport as an implementation detail: it
 * reports `transport` for the connection indicator, and everything above it is
 * written against "the queue changed", not against Socket.IO.
 *
 * Degradation is visible, never silent. A nurse who is looking at a stale board
 * needs to know it, so the transport state is surfaced in the UI rather than
 * hidden behind a hopeful reconnect loop.
 */
const POLL_INTERVAL_MS = 5000;
const SOCKET_GRACE_MS = 4000;

export function useQueue() {
  const [encounters, setEncounters] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [surge, setSurge] = useState({ active: false, metrics: null, policyApplied: null });
  const [transport, setTransport] = useState('connecting');
  const [capacityDebtMinutes, setCapacityDebtMinutes] = useState(0);
  const [lastUpdateAt, setLastUpdateAt] = useState(null);

  const pollTimer = useRef(null);
  const socketRef = useRef(null);

  const loadSnapshot = useCallback(async () => {
    try {
      const { encounters: rows, capacityDebtMinutes: debt } = await api.queue();
      setEncounters(rows);
      if (Number.isFinite(debt)) setCapacityDebtMinutes(debt);
      setLastUpdateAt(new Date());
      return true;
    } catch {
      return false;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollTimer.current) return;
    setTransport('polling');
    pollTimer.current = setInterval(loadSnapshot, POLL_INTERVAL_MS);
  }, [loadSnapshot]);

  const stopPolling = useCallback(() => {
    if (!pollTimer.current) return;
    clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);

  useEffect(() => {
    loadSnapshot();

    const socket = io('/queue', {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    // If the socket has not come up within the grace window, start polling rather
    // than leaving the board frozen while a handshake retries in the background.
    const grace = setTimeout(() => {
      if (!socket.connected) startPolling();
    }, SOCKET_GRACE_MS);

    socket.on('connect', () => {
      stopPolling();
      setTransport('websocket');
      // Re-sync on (re)connect: patches missed while disconnected are not replayed,
      // so the authoritative snapshot is pulled once rather than trusting a diff
      // stream that has a hole in it.
      loadSnapshot();
    });

    socket.on('disconnect', () => startPolling());
    socket.on('connect_error', () => startPolling());

    socket.on('queue:patch', ({ patches, surgeActive, capacityDebtMinutes: debt, tickAt }) => {
      setCapacityDebtMinutes(debt ?? 0);
      setSurge((prior) => ({ ...prior, active: surgeActive }));
      setLastUpdateAt(tickAt ? new Date(tickAt) : new Date());

      setEncounters((prior) => {
        const byId = new Map(prior.map((e) => [String(e._id), e]));
        for (const patch of patches) {
          const existing = byId.get(patch.encounterId);
          if (existing) {
            byId.set(patch.encounterId, {
              ...existing,
              currentESI: patch.currentESI,
              status: patch.status,
              queue: patch.queue,
            });
          }
        }
        const merged = [...byId.values()];
        // The engine sends patches, not an ordering, so the board re-sorts on the
        // same key the backend uses: priority first, then time of arrival.
        merged.sort(
          (a, b) =>
            (b.queue?.priorityScore ?? 0) - (a.queue?.priorityScore ?? 0) ||
            new Date(a.arrivalAt) - new Date(b.arrivalAt),
        );
        return merged;
      });

      // A patch can name an encounter this client has never seen (a new arrival),
      // in which case the diff is not enough and a fresh snapshot is needed.
      setEncounters((prior) => {
        const known = new Set(prior.map((e) => String(e._id)));
        if (patches.some((p) => !known.has(p.encounterId))) loadSnapshot();
        return prior;
      });
    });

    socket.on('patient:alert', (alert) => {
      setAlerts((prior) => [{ ...alert, receivedAt: new Date() }, ...prior].slice(0, 40));
      loadSnapshot();
    });

    socket.on('surge:state', (payload) => {
      setSurge({
        active: payload.active,
        transition: payload.transition,
        trigger: payload.trigger,
        metrics: payload.metrics,
        policyApplied: payload.policyApplied,
      });
    });

    return () => {
      clearTimeout(grace);
      stopPolling();
      socket.close();
    };
  }, [loadSnapshot, startPolling, stopPolling]);

  const dismissAlert = useCallback((index) => {
    setAlerts((prior) => prior.filter((_, i) => i !== index));
  }, []);

  return {
    encounters,
    alerts,
    surge,
    transport,
    capacityDebtMinutes,
    lastUpdateAt,
    refresh: loadSnapshot,
    dismissAlert,
  };
}
