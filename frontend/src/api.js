/** Thin API client. Every call goes through the Vite proxy to the backend. */

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', 'x-workstation': 'TRIAGE-01', ...options.headers },
    ...options,
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The backend's refusals are the interesting ones — a rejected de-escalation
    // explains itself in `message`, and that explanation is what the nurse needs
    // to see, so it is preserved rather than replaced with a generic failure.
    const error = new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const api = {
  health: () => request('/health'),
  protocol: () => request('/protocol'),
  modelInfo: () => request('/model/info'),

  queue: (since) => request(`/queue${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  encounter: (id) => request(`/encounters/${id}`),
  clinicians: () => request('/clinicians'),

  overrideReasons: () => request('/override/reasons'),
  override: (encounterId, payload) =>
    request(`/encounters/${encounterId}/override`, { method: 'POST', body: JSON.stringify(payload) }),

  promotionReasons: () => request('/promotion/reasons'),
  promote: (encounterId, payload) =>
    request(`/encounters/${encounterId}/promote`, { method: 'POST', body: JSON.stringify(payload) }),

  dispositionOptions: () => request('/disposition/options'),
  disposition: (encounterId, payload) =>
    request(`/encounters/${encounterId}/disposition`, { method: 'POST', body: JSON.stringify(payload) }),

  revealIdentity: (encounterId, payload) =>
    request(`/encounters/${encounterId}/reveal-identity`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  audit: (params = {}) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
    return request(`/audit${query ? `?${query}` : ''}`);
  },
  verifyAudit: () => request('/audit/verify'),

  createPatient: (payload) => request('/patients', { method: 'POST', body: JSON.stringify(payload) }),
  createEncounter: (payload) => request('/encounters', { method: 'POST', body: JSON.stringify(payload) }),
  recordVitals: (encounterId, payload) =>
    request(`/encounters/${encounterId}/vitals`, { method: 'POST', body: JSON.stringify(payload) }),

  advanceTime: (payload) => request('/simulate/advance-time', { method: 'POST', body: JSON.stringify(payload) }),

  bedAvailability: () => request('/integrations/beds'),
  hisLookup: ({ phone, abhaId }) => {
    const query = new URLSearchParams(
      Object.entries({ phone, abhaId }).filter(([, v]) => v),
    ).toString();
    return request(`/integrations/his-lookup?${query}`);
  },
};
