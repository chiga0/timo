export const SSE_VERIFIER_VERSION = "sse-v1";
export const MAX_INPUT_BYTES = 32 * 1024;

export type SseEventName = "CONNECT" | "DISCONNECT" | "RECONNECT" | "HEARTBEAT";
export type SseVerdict = "disconnected" | "no_disconnect" | "unknown";

export interface SseIncident {
  connectionId: string;
  disconnectLine: number;
  reconnectLine: number | null;
}

export interface SseCandidate {
  inputDigest: string;
  verdict: SseVerdict;
  incidents: SseIncident[];
}

export type SseParseResult =
  | { ok: true; verdict: "disconnected" | "no_disconnect"; incidents: SseIncident[] }
  | { ok: false; reason: string; line: number | null; verdict: "unknown"; incidents: [] };

export type FindingCode =
  | "verdict_mismatch"
  | "incident_missed"
  | "incident_extra"
  | "line_mismatch"
  | "digest_mismatch"
  | "candidate_malformed"
  | "input_incomplete";

export interface Finding {
  code: FindingCode;
  detail: string;
  incident?: SseIncident;
}

export type VerificationOutcome =
  | { status: "accepted"; verifierVersion: string; digest: string; expected: { verdict: "disconnected" | "no_disconnect"; incidents: SseIncident[] } }
  | { status: "rejected"; verifierVersion: string; digest: string; findings: Finding[] }
  | { status: "incomplete"; verifierVersion: string; digest: string; findings: Finding[] };

const EVENT_NAMES = new Set<string>(["CONNECT", "DISCONNECT", "RECONNECT", "HEARTBEAT"]);
const LINE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))[ \t]+(\S+)[ \t]+(\S+)$/;

export function isSseEventName(name: string): name is SseEventName {
  return EVENT_NAMES.has(name);
}

/**
 * Parses the synthetic SSE log format from docs/m1-delivery.md. Line numbers
 * are 1-based and blank lines keep their number. A RECONNECT closes the earliest
 * still-open DISCONNECT of the same connection.
 */
export function analyzeLog(text: string): SseParseResult {
  const lines = text.split("\n");
  // A trailing newline terminates the last line rather than starting a new one.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const incidents: SseIncident[] = [];
  const open = new Map<string, number[]>();
  let sawNonEmptyLine = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.endsWith("\r") ? lines[index]!.slice(0, -1) : lines[index]!;
    const lineNumber = index + 1;
    if (line.trim() === "") continue;
    sawNonEmptyLine = true;
    const match = LINE_PATTERN.exec(line);
    if (!match) {
      return { ok: false, reason: "line does not match `<timestamp> <connectionId> <event>`", line: lineNumber, verdict: "unknown", incidents: [] };
    }
    const [, timestamp, connectionId, eventName] = match as unknown as [string, string, string, string];
    if (Number.isNaN(Date.parse(timestamp))) {
      return { ok: false, reason: "line has an invalid RFC 3339 timestamp", line: lineNumber, verdict: "unknown", incidents: [] };
    }
    if (!isSseEventName(eventName)) {
      return { ok: false, reason: `line has an unknown event name \`${eventName}\``, line: lineNumber, verdict: "unknown", incidents: [] };
    }
    if (eventName === "DISCONNECT") {
      const pending = open.get(connectionId) ?? [];
      pending.push(lineNumber);
      open.set(connectionId, pending);
    } else if (eventName === "RECONNECT") {
      const pending = open.get(connectionId);
      if (pending && pending.length > 0) {
        const disconnectLine = pending.shift()!;
        incidents.push({ connectionId, disconnectLine, reconnectLine: lineNumber });
        if (pending.length === 0) open.delete(connectionId);
      }
    }
  }

  for (const [connectionId, pending] of open) {
    for (const disconnectLine of pending) {
      incidents.push({ connectionId, disconnectLine, reconnectLine: null });
    }
  }

  incidents.sort((a, b) => a.disconnectLine - b.disconnectLine);
  const unique: SseIncident[] = [];
  for (const incident of incidents) {
    if (unique.length > 0 && unique[unique.length - 1]!.disconnectLine === incident.disconnectLine) continue;
    unique.push(incident);
  }
  if (!sawNonEmptyLine) {
    return { ok: false, reason: "log contains no events", line: null, verdict: "unknown", incidents: [] };
  }
  return { ok: true, verdict: unique.length === 0 ? "no_disconnect" : "disconnected", incidents: unique };
}

/**
 * Compares a model candidate with a deterministic re-analysis of the frozen
 * input. Anything short of exact agreement is rejected.
 */
export function verifyCandidate(input: Uint8Array, digest: string, candidate: unknown): VerificationOutcome {
  const expected = analyzeLog(new TextDecoder("utf-8", { fatal: false }).decode(input));
  const base = { verifierVersion: SSE_VERIFIER_VERSION, digest };

  if (!expected.ok) {
    return {
      status: "incomplete",
      ...base,
      findings: [{ code: "input_incomplete", detail: `${expected.reason}${expected.line === null ? "" : ` (line ${expected.line})`}` }],
    };
  }

  const findings: Finding[] = [];
  const parsed = parseCandidate(candidate);
  if (!parsed) {
    return { status: "rejected", ...base, findings: [{ code: "candidate_malformed", detail: "candidate is not an object with inputDigest, verdict and incidents" }] };
  }
  if (parsed.inputDigest !== digest) {
    findings.push({ code: "digest_mismatch", detail: `candidate digest ${parsed.inputDigest} does not match frozen input ${digest}` });
  }
  if (parsed.verdict !== expected.verdict) {
    findings.push({ code: "verdict_mismatch", detail: `candidate verdict ${parsed.verdict}, expected ${expected.verdict}` });
  }

  const byLine = new Map<number, SseIncident>();
  for (const incident of expected.incidents) byLine.set(incident.disconnectLine, incident);
  const seen = new Set<number>();
  for (const claimed of parsed.incidents) {
    const actual = byLine.get(claimed.disconnectLine);
    if (!actual) {
      findings.push({ code: "incident_extra", detail: `line ${claimed.disconnectLine} is not a disconnect`, incident: claimed });
      continue;
    }
    seen.add(claimed.disconnectLine);
    if (actual.connectionId !== claimed.connectionId || actual.reconnectLine !== claimed.reconnectLine) {
      findings.push({
        code: "line_mismatch",
        detail: `line ${claimed.disconnectLine}: candidate ${claimed.connectionId}/${claimed.reconnectLine ?? "null"}, expected ${actual.connectionId}/${actual.reconnectLine ?? "null"}`,
        incident: claimed,
      });
    }
  }
  for (const actual of expected.incidents) {
    if (!seen.has(actual.disconnectLine)) {
      findings.push({ code: "incident_missed", detail: `disconnect at line ${actual.disconnectLine} was not reported`, incident: actual });
    }
  }

  if (findings.length > 0) return { status: "rejected", ...base, findings };
  return { status: "accepted", ...base, expected: { verdict: expected.verdict, incidents: expected.incidents } };
}

export function parseCandidate(value: unknown): SseCandidate | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { inputDigest, verdict, incidents } = record;
  if (typeof inputDigest !== "string") return null;
  if (verdict !== "disconnected" && verdict !== "no_disconnect" && verdict !== "unknown") return null;
  if (!Array.isArray(incidents)) return null;
  const parsedIncidents: SseIncident[] = [];
  for (const item of incidents) {
    if (typeof item !== "object" || item === null) return null;
    const incident = item as Record<string, unknown>;
    if (typeof incident.connectionId !== "string") return null;
    if (!Number.isInteger(incident.disconnectLine)) return null;
    const reconnectLine = incident.reconnectLine;
    if (reconnectLine !== null && !Number.isInteger(reconnectLine)) return null;
    parsedIncidents.push({
      connectionId: incident.connectionId,
      disconnectLine: incident.disconnectLine as number,
      reconnectLine: reconnectLine as number | null,
    });
  }
  return { inputDigest, verdict, incidents: parsedIncidents };
}

/** The JSON Schema T3 uses as `outputSchema` so the agent submits a structured candidate. */
export const SSE_CANDIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["inputDigest", "verdict", "incidents"],
  properties: {
    inputDigest: { type: "string", description: "SHA-256 hex digest printed in the task prompt. Copy it verbatim." },
    verdict: { type: "string", enum: ["disconnected", "no_disconnect", "unknown"] },
    incidents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["connectionId", "disconnectLine", "reconnectLine"],
        properties: {
          connectionId: { type: "string" },
          disconnectLine: { type: "integer", minimum: 1 },
          reconnectLine: { type: ["integer", "null"], minimum: 1 },
        },
      },
    },
  },
} as const;
