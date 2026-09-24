import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { distill } from "../src/distill.js";
import { sanitizeEvidence } from "../src/analyze.js";
import { foldEvidence, renderEvidenceForPrompt } from "../src/fold.js";
import { parseMemoryUnits } from "../src/memory.js";
import { estimateTokens } from "../src/tokens.js";
import {
  TASK_ID,
  carveEnvelope,
  directiveMetadata,
  extractDirectives,
  isDirectiveId,
  renderDirectiveIndex,
} from "../src/directives.js";
import * as claude from "../src/discovery/adapters/claude.js";
import * as pi from "../src/discovery/adapters/pi.js";

const FIXTURES = path.dirname(fileURLToPath(import.meta.url));
const META = {
  id: "directive-demo",
  harness: "claude",
  association: { tier: 1, confidence: "exact" },
  rawPath: "/tmp/directive-spans.jsonl",
};

function fixtureEvents() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, "fixtures/directive-spans.json"), "utf8"));
}

test("only the authoritative envelope becomes instruction text", () => {
  const { envelope, excluded } = carveEnvelope(fixtureEvents()[0].text);
  assert.match(envelope, /Migrate the auth module/);
  assert.match(envelope, /Keep the public function names unchanged/);
  assert.ok(!envelope.includes("previous assistant said"), "quoted transcript must not be authority");
  assert.ok(!envelope.includes("refreshSession"), "pasted tool output must not be authority");
  assert.deepEqual(excluded.map((entry) => entry.kind).sort(), ["blockquote", "blockquote", "code-block"]);
});

test("an unclosed fence still withholds the paste", () => {
  const { envelope } = carveEnvelope("Do the migration.\n```\nError: boom");
  assert.equal(envelope, "Do the migration.");
});

test("the first substantive user turn is the task, later ones are steering", () => {
  const { turns } = distill(fixtureEvents(), META);
  const spans = extractDirectives(turns);
  assert.deepEqual(
    spans.map((span) => [span.id, span.kind, span.turn, span.authority]),
    [
      [TASK_ID, "task", 1, "direct-task"],
      ["STEER-4", "steering", 4, "direct-steering"],
    ],
  );
  // "thanks" is an ack, not an instruction; the assistant reply and tool result never index.
  assert.ok(spans.every((span) => span.turn !== 2 && span.turn !== 3));
  assert.ok(isDirectiveId("TASK-1") && isDirectiveId("STEER-4"));
  assert.ok(!isDirectiveId("AG-001") && !isDirectiveId("TASK-2") && !isDirectiveId("banana"));
});

test("an explicit revision closes earlier lifetimes and nothing else does", () => {
  const { turns } = distill(fixtureEvents(), META);
  const [task, steering] = extractDirectives(turns);
  assert.equal(task.supersededBy, "STEER-4");
  assert.deepEqual(task.lifetime, { fromTurn: 1, toTurn: 4 });
  assert.equal(steering.supersededBy, null);
  assert.deepEqual(steering.lifetime, { fromTurn: 4, toTurn: null });

  const plain = extractDirectives([
    { turn: 1, role: "user", text: "Migrate the auth module to tokens." },
    { turn: 2, role: "assistant", text: "Done." },
    { turn: 3, role: "user", text: "Also update the changelog for this release." },
  ]);
  assert.equal(plain[0].supersededBy, null, "an addition is not a revision");
  assert.deepEqual(plain[0].lifetime, { fromTurn: 1, toTurn: null });
});

test("a message that is only quotes and pastes yields no span", () => {
  const spans = extractDirectives([
    { turn: 1, role: "user", text: "> quoted transcript line\n\n```\npasted output\n```" },
    { turn: 2, role: "assistant", text: "Noted." },
  ]);
  assert.deepEqual(spans, []);
  assert.match(renderDirectiveIndex(spans), /\(none/);
});

test("the index renders by reference and never repeats turn text", () => {
  const { turns, trace } = distill(fixtureEvents(), META);
  const spans = extractDirectives(turns);
  const section = renderDirectiveIndex(spans);
  assert.match(section, /\[TASK-1\] task · turn 1 · authority direct-task/);
  assert.match(section, /see turn 1 in the trace/);
  assert.match(section, /superseded by \[STEER-4\]/);
  for (const entry of turns.filter((candidate) => candidate.role === "user")) {
    const { envelope } = carveEnvelope(entry.text);
    if (envelope.length > 200) {
      assert.ok(!section.includes(envelope), `turn ${entry.turn} text must not be duplicated`);
    }
  }
  assert.ok(trace.includes("Migrate the auth module"), "the trace itself still carries the text");
});

test("sanitizeEvidence accepts issued directive ids and drops the rest", () => {
  const memoryFile = { units: parseMemoryUnits("# T\n\n- First rule\n") };
  const clean = sanitizeEvidence(
    {
      positive: [
        { instruction: "TASK-1", quote: "Migrate the auth module", effect: "followed the brief" },
        { instruction: "STEER-4", quote: "keep the old refresh-token flow", effect: "kept it" },
        { instruction: "AG-001", quote: "First rule", effect: "followed memory too" },
        { instruction: "AG-999", quote: "First rule", effect: "hallucinated memory id" },
        { instruction: "STEER-9", quote: "First rule", effect: "hallucinated steering id" },
      ],
      usedRawTranscript: true,
    },
    memoryFile,
    null,
    ["TASK-1", "STEER-4"],
  );
  assert.deepEqual(
    clean.positive.map((item) => item.instruction),
    ["TASK-1", "STEER-4", "AG-001"],
  );
});

test("the fold keeps directive cites out of memory-instruction rows", () => {
  const spans = extractDirectives(distill(fixtureEvents(), META).turns);
  const meta = directiveMetadata(spans);
  assert.ok(
    JSON.stringify(meta).length < 800 && !JSON.stringify(meta).includes("Migrate"),
    "persisted metadata carries ids and spans, never turn text",
  );
  const memoryFile = { units: parseMemoryUnits("# T\n\n- First rule\n") };
  const base = (id) => ({
    status: "ok",
    transcript: { id, harness: "claude", startedAt: Date.parse("2026-08-01T00:00:00Z") },
    positive: [],
    negative: [],
    gaps: [],
  });
  const summary = foldEvidence(
    [
      {
        ...base("s1"),
        directives: meta,
        positive: [{ instruction: "TASK-1", quote: "Migrate the auth module", effect: "followed it" }],
        negative: [{ instruction: "STEER-4", quote: "old refresh-token flow", effect: "dropped it", class: "harm" }],
      },
      {
        ...base("s2"),
        directives: [],
        negative: [{ instruction: "TASK-1", quote: "Migrate the auth module", effect: "no span issued here" }],
      },
    ],
    { memoryFile },
  );
  assert.equal(summary.directives.length, 2, "one row per session span, never merged across sessions");
  const task = summary.directives.find((row) => row.sessionId === "s1" && row.id === "TASK-1");
  assert.equal(task.positive, 1);
  assert.equal(task.authority, "direct-task");
  assert.equal(task.supersededBy, "STEER-4");
  const stale = summary.instructions.find((row) => row.instruction === "TASK-1");
  assert.ok(stale && stale.known === false, "the undeclared TASK-1 cite keeps today's stale-reference row");
  assert.equal(
    summary.totals.instructionsWithNegatives,
    0,
    "directive negatives never enter the existing-instruction lane",
  );
  const prompt = renderEvidenceForPrompt(summary);
  assert.match(prompt, /Direct task\/steering instructions cited/);
  assert.match(prompt, /\[TASK-1\] task · turn 1/);
  assert.match(prompt, /never rewrite them/);
});

test("the directive index costs a fraction of duplicating the turns it points at", () => {
  const cases = [
    { file: "claude-session.jsonl", read: (ref) => claude.read(ref) },
    { file: "pi-session.jsonl", read: (ref) => pi.read(ref) },
  ];
  for (const { file, read } of cases) {
    const candidate = { key: file, path: path.join(FIXTURES, "fixtures", file) };
    const stat = fs.statSync(candidate.path);
    candidate.mtimeMs = stat.mtimeMs;
    candidate.bytes = stat.size;
    const { events } = read({ path: candidate.path });
    const distilled = distill(events, {
      ...META,
      harness: candidate.path.includes("pi-") ? "pi" : "claude",
    });
    const spans = extractDirectives(distilled.turns);
    const section = renderDirectiveIndex(spans, { elided: distilled.stats.elided });
    const sectionTokens = estimateTokens(section);
    // By-reference cost scales with the span count, never the turn length: one
    // bounded entry per span, whatever the turn says.
    if (spans.length) {
      assert.ok(
        sectionTokens <= spans.length * 50,
        `${file}: ${spans.length} span(s) must cost at most ~50 tok each, got ${sectionTokens} tok`,
      );
    }
    console.log(
      `directives ${file}: +${sectionTokens} tok index for ${spans.length} span(s) ` +
        `on ${estimateTokens(distilled.trace)} tok trace`,
    );
  }
  // Where it matters - long task turns - by-reference beats duplicating the text.
  const long = distill(fixtureEvents(), META);
  const longSpans = extractDirectives(long.turns);
  const longSection = estimateTokens(renderDirectiveIndex(longSpans));
  const duplicated = longSpans.reduce(
    (sum, span) => sum + estimateTokens(long.turns.find((entry) => entry.turn === span.turn)?.text || ""),
    0,
  );
  assert.ok(
    longSection < duplicated,
    `directive-spans fixture: index (${longSection} tok) must beat duplication (${duplicated} tok)`,
  );
  console.log(`directives directive-spans.json: +${longSection} tok index vs ${duplicated} tok duplicated`);
});
