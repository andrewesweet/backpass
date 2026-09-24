/**
 * Direct task and steering instructions as addressable instruction sources.
 *
 * Backpass indexes project memory files as instruction sources, but in real sessions
 * much of what governs agent behaviour comes straight from the user: the initial task
 * message and later steering turns. Without ids those read only as undifferentiated
 * transcript evidence, so analysis cannot say "the agent followed the user's direct
 * instruction" apart from "the agent followed the memory file". This module makes each
 * substantive user turn citable:
 *
 *   - the first user turn's authoritative envelope is the task span (`TASK-1`)
 *   - each later substantive user turn is a steering span (`STEER-<turn>`)
 *   - every span carries source kind, turn, an authority tier distinct from project
 *     memory (`direct-task` / `direct-steering`), and a lifetime (from its turn
 *     onward, closed only by later steering with an explicit revision signal)
 *
 * Only the authoritative envelope of a user message becomes a span. Quoted transcripts
 * (`>` blockquotes), pasted tool output and code (fenced blocks), retry reasons and
 * planned actions embedded as quotes or pastes are structurally excluded: indexing
 * them as authority would invert instructions that say to treat that text as
 * untrusted evidence. Assistant messages and tool results never become spans.
 *
 * Spans are extracted from the distilled message turns, so turn numbers match the
 * trace the analysis model reads. The prompt index renders them by reference (id plus
 * a `see turn N` pointer), never by duplicating turn text: task and steering text is
 * private by default, and only ids plus metadata (`directives` on the evidence
 * record) ever persist - envelope text never leaves the in-memory prompt.
 */

export const TASK_ID = "TASK-1";
export const TASK_AUTHORITY = "direct-task";
export const STEERING_AUTHORITY = "direct-steering";

/** Envelopes shorter than this carry no judgable instruction (acks, greetings). */
export const MIN_ENVELOPE_WORDS = 3;

/**
 * A later steering envelope supersedes earlier spans only on an explicit revision
 * signal - a structural admission that the user is revising, not merely adding.
 * Deliberately narrow: a bare "instead" also appears in fresh instructions, and an
 * over-eager supersede would silently close a task lifetime that still governs.
 */
const REVISION_SIGNAL =
  /\b(actually|scratch that|forget (that|it|what i said)|ignore my (previous|last|earlier) (instructions?|message|request)|on second thought|change of plans?|disregard that|correction:)/i;

const FENCE = /^\s*(```|~~~)/;
const QUOTE = /^\s*>/;

/** A span id is stable by construction: kind plus the distilled turn it points at. */
export function isDirectiveId(id) {
  return id === TASK_ID || /^STEER-\d+$/.test(String(id || ""));
}

function steeringId(turn) {
  return `STEER-${turn}`;
}

/**
 * Split a user message into its authoritative envelope and the embedded untrusted
 * blocks. Fenced code blocks (pasted tool output, code, retry logs) and blockquote
 * lines (quoted transcripts, pasted replies, planned actions quoted back) are
 * evidence-only, never authority. Returns the envelope plus what was excluded, so
 * tests can prove a quoted transcript never becomes instruction text.
 */
export function carveEnvelope(text) {
  const excluded = [];
  const kept = [];
  let inFence = false;
  let fenceBuffer = [];

  const flushFence = () => {
    if (fenceBuffer.length) excluded.push({ kind: "code-block", text: fenceBuffer.join("\n").trim() });
    fenceBuffer = [];
  };

  for (const line of String(text ?? "").split("\n")) {
    if (FENCE.test(line)) {
      if (inFence) {
        fenceBuffer.push(line);
        flushFence();
      } else {
        fenceBuffer.push(line);
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fenceBuffer.push(line);
      continue;
    }
    if (QUOTE.test(line)) {
      excluded.push({ kind: "blockquote", text: line.replace(/^\s*>\s?/, "").trim() });
      continue;
    }
    kept.push(line);
  }
  // An unclosed fence still withholds the rest: a pasted log without a closing
  // marker is still a paste, not an instruction.
  if (inFence) flushFence();

  return { envelope: kept.join("\n").trim(), excluded };
}

function envelopeWords(envelope) {
  return envelope.split(/\s+/).filter(Boolean).length;
}

/**
 * Index the substantive user turns of one session. `turns` are the distilled message
 * turns (`{ turn, role, text }`) in trace order, so ids stay stable across runs of the
 * same transcript and always point at text the model was actually sent.
 */
export function extractDirectives(turns) {
  const spans = [];
  const envelopes = new Map();
  let seenFirstUser = false;
  for (const entry of Array.isArray(turns) ? turns : []) {
    if (!entry || entry.role !== "user") continue;
    const { envelope } = carveEnvelope(entry.text);
    if (envelopeWords(envelope) < MIN_ENVELOPE_WORDS) continue;
    const span = !seenFirstUser
      ? { id: TASK_ID, kind: "task", turn: entry.turn, authority: TASK_AUTHORITY }
      : { id: steeringId(entry.turn), kind: "steering", turn: entry.turn, authority: STEERING_AUTHORITY };
    seenFirstUser = true;
    spans.push({ ...span, lifetime: { fromTurn: entry.turn, toTurn: null }, supersededBy: null });
    envelopes.set(entry.turn, envelope);
  }
  // Close lifetimes where a revision is detectable: each span is superseded by the
  // next steering span whose envelope carries an explicit revision signal.
  const revisers = spans.filter(
    (span) => span.kind === "steering" && REVISION_SIGNAL.test(envelopes.get(span.turn) || ""),
  );
  for (const span of spans) {
    const superseder = revisers.find((other) => other.turn > span.turn);
    if (superseder) {
      span.supersededBy = superseder.id;
      span.lifetime.toTurn = superseder.turn;
    }
  }
  return spans;
}

/** Metadata that may persist on an evidence record: ids and spans, never turn text. */
export function directiveMetadata(spans) {
  return (Array.isArray(spans) ? spans : []).map((span) => ({
    id: span.id,
    kind: span.kind,
    turn: span.turn,
    authority: span.authority,
    lifetime: { ...span.lifetime },
    supersededBy: span.supersededBy,
  }));
}

/**
 * The analysis-prompt index. By reference only: each entry names the turn whose text
 * is already in the trace, so no user-turn text is duplicated into the prompt.
 */
export function renderDirectiveIndex(spans, { elided = false } = {}) {
  const list = Array.isArray(spans) ? spans : [];
  if (!list.length) return "(none - no substantive user instruction found in the trace)";
  const lines = list.map((span) => {
    const life =
      span.lifetime?.toTurn != null
        ? `lifetime turns ${span.lifetime.fromTurn}-${span.lifetime.toTurn - 1}`
        : `lifetime turns ${span.lifetime?.fromTurn ?? span.turn}+`;
    const superseded = span.supersededBy ? `, superseded by [${span.supersededBy}] (explicit revision)` : "";
    return (
      `[${span.id}] ${span.kind} · turn ${span.turn} · authority ${span.authority} · ` +
      `${life}${superseded} - see turn ${span.turn} in the trace`
    );
  });
  if (elided) {
    lines.push(
      "The trace middle was elided; a cited turn may sit in the elided span - " +
        "open the raw transcript when a claim needs its text.",
    );
  }
  return lines.join("\n");
}
