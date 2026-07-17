import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDeciderPrompt,
  buildSeatPlan,
  buildSeatPrompt,
  DEFAULT_COUNCIL_SEATS,
  runCouncil,
  runCouncilRound1,
  runCouncilRound2
} from "../plugins/codex/scripts/lib/council.mjs";

function makeEnvelope(status, summary) {
  return { status, summary, files_modified: [], concerns: [], blocked_reason: null };
}

test("buildSeatPlan defaults to 3 seats: advocate, counter, decider", () => {
  const seats = buildSeatPlan();
  assert.equal(seats.length, DEFAULT_COUNCIL_SEATS);
  assert.deepEqual(
    seats.map((seat) => seat.stance),
    ["advocate", "counter", "decider"]
  );
  assert.equal(seats.every((seat) => seat.tier === "sol" && seat.effort === "high"), true);
});

test("buildSeatPlan scales to M seats, alternating advocate/counter before the decider", () => {
  const seats = buildSeatPlan(5);
  assert.deepEqual(
    seats.map((seat) => seat.stance),
    ["advocate", "counter", "advocate", "counter", "decider"]
  );
});

test("buildSeatPlan applies per-seat and decider-specific tier/effort overrides", () => {
  const seats = buildSeatPlan(3, {
    tier: "terra",
    effort: "medium",
    deciderTier: "sol",
    deciderEffort: "xhigh",
    seats: [{ tier: "luna", effort: "low" }]
  });
  assert.equal(seats[0].tier, "luna");
  assert.equal(seats[0].effort, "low");
  assert.equal(seats[1].tier, "terra");
  assert.equal(seats[1].effort, "medium");
  assert.equal(seats[2].tier, "sol");
  assert.equal(seats[2].effort, "xhigh");
});

test("buildSeatPrompt frames advocate and counter stances distinctly and includes the topic", () => {
  const advocatePrompt = buildSeatPrompt("advocate", "Should we ship X?");
  const counterPrompt = buildSeatPrompt("counter", "Should we ship X?");
  assert.match(advocatePrompt, /Argue FOR/);
  assert.match(counterPrompt, /Argue AGAINST/);
  assert.match(advocatePrompt, /Should we ship X\?/);
});

test("round-1 seats are isolated: each prompt contains only the topic, never another seat's output", async () => {
  const seatPlan = buildSeatPlan(3);
  const seenPrompts = [];

  const runTurn = async (cwd, options) => {
    seenPrompts.push(options.prompt);
    return {
      status: 0,
      finalMessage: "",
      envelope: makeEnvelope("DONE", `summary for ${options.tier}`)
    };
  };

  await runCouncilRound1("/repo", "Should we ship X?", seatPlan, { runTurn });

  assert.equal(seenPrompts.length, 2, "only the two non-decider seats should run in round 1");
  for (const prompt of seenPrompts) {
    assert.doesNotMatch(prompt, /Round 1 transcripts/);
    for (const otherPrompt of seenPrompts) {
      if (otherPrompt !== prompt) {
        assert.doesNotMatch(prompt, new RegExp(otherPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    }
  }
});

test("round-2 decider prompt includes both round-1 transcripts", () => {
  const round1Outputs = [
    { seat: 0, stance: "advocate", summary: "Ship it: the upside outweighs the risk." },
    { seat: 1, stance: "counter", summary: "Do not ship: the rollback plan is untested." }
  ];
  const prompt = buildDeciderPrompt("Should we ship X?", round1Outputs);
  assert.match(prompt, /Ship it: the upside outweighs the risk\./);
  assert.match(prompt, /Do not ship: the rollback plan is untested\./);
  assert.match(prompt, /Seat 0 \(advocate\)/);
  assert.match(prompt, /Seat 1 \(counter\)/);
});

test("runCouncilRound2 forwards the decider seat's tier/effort and captures its envelope", async () => {
  const deciderSeat = { index: 2, stance: "decider", tier: "sol", effort: "xhigh" };
  const calls = [];
  const runTurn = async (cwd, options) => {
    calls.push(options);
    return {
      status: 0,
      finalMessage: "",
      envelope: makeEnvelope("DONE", "Final verdict: ship it.")
    };
  };

  const result = await runCouncilRound2("/repo", "topic", [], deciderSeat, { runTurn });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tier, "sol");
  assert.equal(calls[0].effort, "xhigh");
  assert.equal(result.summary, "Final verdict: ship it.");
  assert.equal(result.stance, "decider");
});

test("runCouncil returns verdict, seat_outputs (round 1 + decider), and agreement_notes", async () => {
  const runTurn = async (cwd, options) => {
    if (options.prompt.includes("Argue FOR")) {
      return { status: 0, finalMessage: "", envelope: makeEnvelope("DONE", "Advocate says ship.") };
    }
    if (options.prompt.includes("Argue AGAINST")) {
      return { status: 0, finalMessage: "", envelope: makeEnvelope("DONE", "Counter says ship too.") };
    }
    return { status: 0, finalMessage: "", envelope: makeEnvelope("DONE", "Decider verdict: ship it.") };
  };

  const result = await runCouncil("/repo", "Should we ship X?", { runTurn });

  assert.equal(result.verdict, "Decider verdict: ship it.");
  assert.equal(result.seat_outputs.length, 3);
  assert.deepEqual(
    result.seat_outputs.map((seat) => seat.stance),
    ["advocate", "counter", "decider"]
  );
  assert.equal(result.agreement_notes.length, 1);
  assert.match(result.agreement_notes[0], /All 2 round-1 seats returned status DONE/);
});

test("runCouncil surfaces disagreement and quota-exhaustion in agreement_notes", async () => {
  let call = 0;
  const runTurn = async (cwd, options) => {
    call += 1;
    if (options.prompt.includes("Argue FOR")) {
      return {
        status: "BLOCKED",
        blocked_reason: "QUOTA_EXHAUSTED",
        summary: "Quota exhausted at tier sol and step-down tier terra.",
        files_modified: [],
        concerns: []
      };
    }
    if (options.prompt.includes("Argue AGAINST")) {
      return { status: 0, finalMessage: "", envelope: makeEnvelope("NEEDS_CONTEXT", "Need more info.") };
    }
    return { status: 0, finalMessage: "", envelope: makeEnvelope("DONE_WITH_CONCERNS", "Proceed cautiously.") };
  };

  const result = await runCouncil("/repo", "topic", { runTurn });
  assert.match(result.agreement_notes.join(" "), /Quota exhausted for seat\(s\): advocate/);
});

test("runCouncilRound1 falls back to the raw final message when a seat's reply has no parseable envelope", async () => {
  const seatPlan = buildSeatPlan(2);
  const runTurn = async () => ({
    status: 0,
    finalMessage: "Comments should explain why, not what -- the code already says what.",
    envelope: null
  });

  const [seatResult] = await runCouncilRound1("/repo", "topic", seatPlan, { runTurn });

  assert.equal(seatResult.summary, "Comments should explain why, not what -- the code already says what.");
});

test("runCouncil rejects an empty topic", async () => {
  await assert.rejects(runCouncil("/repo", "   ", { runTurn: async () => ({}) }), /non-empty topic/);
});
