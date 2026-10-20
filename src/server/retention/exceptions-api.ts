/**
 * DATA MATCH EXCEPTIONS API CORE (stage 3a) — the management-only server API
 * for the Data Match Exceptions queue (plan §7; owner spec: ambiguity is
 * never guessed, it is queued for management; manual resolves persist and are
 * NEVER re-matched).
 *
 *   GET  /api/retention-exceptions?status=open|resolved|dismissed|(empty=all)
 *        → { counts: {open,resolved,dismissed,total}, exceptions: [...], candidates expanded }
 *   POST /api/retention-exceptions  body: { action, id, ... }
 *        action "resolve"      → { id, internalClientId, resolvedBy } — writes the STICKY
 *                                manual member link (match_method='manual') + closes the
 *                                exception. Audited via manual_overrides (store layer).
 *        action "resolve_new"  → { id, displayName?, phone?, email?, resolvedBy } —
 *                                creates a NEW internal client (the "different clients"
 *                                action, plan §7) then resolves to it (same sticky path).
 *        action "dismiss"      → { id, resolvedBy } — closes without a link write
 *                                (e.g. call-identity/phone_mismatch rows reviewed and
 *                                accepted as-is). Audited.
 *
 * Every action validates that the target exception is still OPEN — a resolved
 * or dismissed row can never be re-resolved (write-once discipline; the
 * sticky link it wrote stays). resolvedBy defaults to "management" and rides
 * every audit row.
 *
 * Served from two places (same code): serve.ts (production, behind the
 * passphrase gate) and vite.config.ts dev middleware (working site). NO UI in
 * this stage — the drill-down page is a later delegation.
 */
import type { Store } from "../store/types";
import { normalizeEmail, normalizeUSPhone } from "../identity/normalize";

export interface ExceptionsApiResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleExceptionsQuery(
  store: Store,
  input: { status?: string | null },
): Promise<ExceptionsApiResult> {
  const status = input.status && ["open", "resolved", "dismissed"].includes(input.status) ? input.status : undefined;
  const [all, countOpen, countResolved, countDismissed] = await Promise.all([
    store.getDataMatchExceptions(status ? { status } : undefined),
    store.countDataMatchExceptions("open"),
    store.countDataMatchExceptions("resolved"),
    store.countDataMatchExceptions("dismissed"),
  ]);
  // Candidate expansion: the payload's candidate client ids → client cards so
  // management sees the side-by-side identity evidence without another call.
  const candidateIds = [...new Set(all.flatMap((e) => (Array.isArray((e.payload as { candidates?: unknown }).candidates) ? ((e.payload as { candidates: unknown[] }).candidates as unknown[]).filter((c): c is string => typeof c === "string") : [])))];
  const clients = candidateIds.length ? await store.getInternalClientsByIds(candidateIds) : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const resolvedClientIds = [...new Set(all.map((e) => e.resolved_internal_client_id).filter((x): x is string => !!x))];
  const resolvedClients = resolvedClientIds.length ? await store.getInternalClientsByIds(resolvedClientIds) : [];
  const resolvedById = new Map(resolvedClients.map((c) => [c.id, c]));
  return {
    status: 200,
    body: {
      counts: { open: countOpen, resolved: countResolved, dismissed: countDismissed, total: countOpen + countResolved + countDismissed },
      exceptions: all.map((e) => ({
        ...e,
        candidates_expanded: ((e.payload as { candidates?: unknown }).candidates ?? [])
          .filter((c): c is string => typeof c === "string")
          .map((c) => clientById.get(c) ?? null),
        resolved_client: e.resolved_internal_client_id ? resolvedById.get(e.resolved_internal_client_id) ?? null : null,
      })),
    },
  };
}

export interface ExceptionActionResult {
  action: string;
  id?: string;
  internalClientId?: string;
  displayName?: string;
  phone?: string;
  email?: string;
  resolvedBy?: string;
}

export async function handleExceptionAction(store: Store, input: ExceptionActionResult): Promise<ExceptionsApiResult> {
  const resolvedBy = (input.resolvedBy ?? "management").slice(0, 120);
  if (!input.id) return { status: 400, body: { error: "id is required" } };
  const exc = (await store.getDataMatchExceptions()).find((e) => e.id === input.id);
  if (!exc) return { status: 404, body: { error: `unknown exception ${input.id}` } };
  if (exc.status !== "open") {
    // Write-once: a resolved/dismissed exception is final (its sticky link stays).
    return { status: 409, body: { error: `exception ${input.id} is already ${exc.status} — write-once, cannot be re-${input.action}` } };
  }

  if (input.action === "resolve") {
    if (!input.internalClientId) return { status: 400, body: { error: "internalClientId is required for action=resolve" } };
    const clients = await store.getInternalClientsByIds([input.internalClientId]);
    if (!clients.length) return { status: 400, body: { error: `unknown internal client ${input.internalClientId}` } };
    await store.resolveDataMatchException(input.id, { internalClientId: input.internalClientId, resolvedBy });
    return { status: 200, body: { ok: true, action: "resolve", id: input.id, internal_client_id: input.internalClientId, resolved_by: resolvedBy, sticky: "manual link written — auto passes never re-match this entity" } };
  }

  if (input.action === "resolve_new") {
    // The plan §7 "different clients" action: create a fresh internal client
    // from the subject's identity attributes (or the caller-supplied ones),
    // then resolve onto it through the same sticky manual path.
    const payload = exc.payload as {
      subject?: { name?: string | null; phone?: string | null; email?: string | null };
    };
    const displayName = input.displayName ?? payload.subject?.name ?? null;
    const phone = input.phone ?? payload.subject?.phone ?? null;
    const email = input.email ?? payload.subject?.email ?? null;
    const client = await store.insertInternalClient({
      seedKey: null, // manual-only client: no deterministic seed key (created BY management, not a backfill pass)
      displayName,
      normalizedPhone: normalizeUSPhone(phone),
      normalizedEmail: normalizeEmail(email),
      ghlContactExternalId: null,
      matchState: "manual_resolved",
    });
    await store.resolveDataMatchException(input.id, { internalClientId: client.id, resolvedBy });
    return { status: 200, body: { ok: true, action: "resolve_new", id: input.id, internal_client_id: client.id, resolved_by: resolvedBy } };
  }

  if (input.action === "dismiss") {
    await store.dismissDataMatchException(input.id, { resolvedBy });
    return { status: 200, body: { ok: true, action: "dismiss", id: input.id, resolved_by: resolvedBy } };
  }

  return { status: 400, body: { error: `unknown action "${input.action}" — expected resolve | resolve_new | dismiss` } };
}
