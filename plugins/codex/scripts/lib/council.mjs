/**
 * Rig-edition council verb: M seats debate a topic in two rounds.
 *
 * Round 1 runs every non-decider seat concurrently and in isolation -- each
 * seat only ever sees the topic, never another seat's output. Round 2 runs
 * a single decider seat whose prompt includes every round-1 transcript, and
 * whose summary becomes the council verdict.
 *
 * Additive layer over rig-edition.mjs; tiers/effort per seat default to the
 * same sol/high used by the existing review and adversarial verbs.
 *
 * @typedef {"advocate" | "counter" | "decider"} CouncilStance
 * @typedef {{ index: number, stance: CouncilStance, tier: string, effort: string }} CouncilSeat
 * @typedef {{
 *   seat: number,
 *   stance: CouncilStance,
 *   envelope: import("./rig-edition.mjs").Envelope | null,
 *   summary: string,
 *   quotaExhausted: boolean
 * }} CouncilSeatResult
 */
import { QUOTA_EXHAUSTED_REASON, runTieredTurn } from "./rig-edition.mjs";

export const DEFAULT_COUNCIL_SEATS = 3;

const NON_DECIDER_STANCES = Object.freeze(["advocate", "counter"]);

const STANCE_INSTRUCTIONS = Object.freeze({
  advocate:
    "Argue FOR the strongest case on this topic. Be rigorous, not reflexive -- ground every claim in the topic material.",
  counter:
    "Argue AGAINST the proposal, or surface the strongest counter-case, risks, and failure modes on this topic.",
  decider: "You are the decider. Weigh the round-1 transcripts below and produce a final verdict."
});

/**
 * Builds the seat plan for a council: seatCount - 1 non-decider seats
 * (alternating advocate/counter), then one decider seat last.
 * @param {number} [seatCount]
 * @param {{ tier?: string, effort?: string, deciderTier?: string, deciderEffort?: string, seats?: Array<{ tier?: string, effort?: string }> }} [overrides]
 * @returns {Readonly<CouncilSeat[]>}
 */
export function buildSeatPlan(seatCount = DEFAULT_COUNCIL_SEATS, overrides = {}) {
  const count = Number.isInteger(seatCount) && seatCount >= 2 ? seatCount : DEFAULT_COUNCIL_SEATS;
  const perSeatOverrides = Array.isArray(overrides.seats) ? overrides.seats : [];
  const seats = [];

  for (let index = 0; index < count - 1; index += 1) {
    const stance = NON_DECIDER_STANCES[index % NON_DECIDER_STANCES.length];
    seats.push(
      Object.freeze({
        index,
        stance,
        tier: perSeatOverrides[index]?.tier ?? overrides.tier ?? "sol",
        effort: perSeatOverrides[index]?.effort ?? overrides.effort ?? "high"
      })
    );
  }

  seats.push(
    Object.freeze({
      index: count - 1,
      stance: "decider",
      tier: perSeatOverrides[count - 1]?.tier ?? overrides.deciderTier ?? overrides.tier ?? "sol",
      effort: perSeatOverrides[count - 1]?.effort ?? overrides.deciderEffort ?? overrides.effort ?? "high"
    })
  );

  return Object.freeze(seats);
}

/**
 * @param {CouncilStance} stance
 * @param {string} topic
 */
export function buildSeatPrompt(stance, topic) {
  const instruction = STANCE_INSTRUCTIONS[stance] ?? STANCE_INSTRUCTIONS.advocate;
  return `${instruction}\n\nTopic:\n${topic}`;
}

/**
 * @param {string} topic
 * @param {CouncilSeatResult[]} round1Outputs
 */
export function buildDeciderPrompt(topic, round1Outputs) {
  const transcripts = round1Outputs
    .map((seatResult) => `### Seat ${seatResult.seat} (${seatResult.stance})\n${seatResult.summary || "(no summary)"}`)
    .join("\n\n");
  return `${STANCE_INSTRUCTIONS.decider}\n\nTopic:\n${topic}\n\nRound 1 transcripts:\n\n${transcripts}`;
}

// Council seats are prompted to debate a topic, not to emit a structured
// envelope -- most "pure-reply" turns will have no parseable envelope, so
// the summary must fall back to the raw final message rather than going
// silently empty (an empty summary would defeat the point of a council).
function summarizeOutcome(outcome) {
  if (outcome?.status === "BLOCKED" && outcome?.blocked_reason === QUOTA_EXHAUSTED_REASON) {
    return outcome.summary;
  }
  if (outcome?.envelope?.summary) {
    return outcome.envelope.summary;
  }
  return typeof outcome?.finalMessage === "string" ? outcome.finalMessage.trim() : "";
}

async function runSeatTurn(cwd, seat, prompt, runTurn) {
  const outcome = await runTurn(cwd, { tier: seat.tier, effort: seat.effort, prompt, sandbox: "read-only" });
  const quotaExhausted = outcome?.status === "BLOCKED" && outcome?.blocked_reason === QUOTA_EXHAUSTED_REASON;

  return Object.freeze({
    seat: seat.index,
    stance: seat.stance,
    envelope: quotaExhausted ? outcome : outcome?.envelope ?? null,
    summary: summarizeOutcome(outcome),
    quotaExhausted
  });
}

/**
 * Runs every non-decider seat concurrently, each in isolation from the
 * others -- no seat's prompt references another seat's output.
 * @param {string} cwd
 * @param {string} topic
 * @param {CouncilSeat[]} seatPlan
 * @param {{ runTurn?: typeof runTieredTurn }} [options]
 * @returns {Promise<Readonly<CouncilSeatResult[]>>}
 */
export async function runCouncilRound1(cwd, topic, seatPlan, options = {}) {
  const runTurn = options.runTurn ?? runTieredTurn;
  const nonDeciderSeats = seatPlan.filter((seat) => seat.stance !== "decider");
  const seatResults = await Promise.all(
    nonDeciderSeats.map((seat) => runSeatTurn(cwd, seat, buildSeatPrompt(seat.stance, topic), runTurn))
  );
  return Object.freeze(seatResults);
}

/**
 * Runs the decider seat with a prompt built from every round-1 transcript.
 * @param {string} cwd
 * @param {string} topic
 * @param {CouncilSeatResult[]} round1Outputs
 * @param {CouncilSeat} deciderSeat
 * @param {{ runTurn?: typeof runTieredTurn }} [options]
 * @returns {Promise<Readonly<CouncilSeatResult>>}
 */
export async function runCouncilRound2(cwd, topic, round1Outputs, deciderSeat, options = {}) {
  const runTurn = options.runTurn ?? runTieredTurn;
  const prompt = buildDeciderPrompt(topic, round1Outputs);
  return runSeatTurn(cwd, deciderSeat, prompt, runTurn);
}

function buildAgreementNotes(round1Outputs) {
  const notes = [];
  const withEnvelope = round1Outputs.filter((seat) => seat.envelope && typeof seat.envelope.status === "string");

  if (withEnvelope.length < 2) {
    notes.push("Insufficient round-1 envelopes to compare agreement.");
  } else {
    const statuses = new Set(withEnvelope.map((seat) => seat.envelope.status));
    if (statuses.size === 1) {
      notes.push(`All ${withEnvelope.length} round-1 seats returned status ${[...statuses][0]}.`);
    } else {
      notes.push(
        `Round-1 seats disagreed on status: ${withEnvelope.map((seat) => `${seat.stance}=${seat.envelope.status}`).join(", ")}.`
      );
    }
  }

  const quotaExhaustedSeats = round1Outputs.filter((seat) => seat.quotaExhausted).map((seat) => seat.stance);
  if (quotaExhaustedSeats.length > 0) {
    notes.push(`Quota exhausted for seat(s): ${quotaExhaustedSeats.join(", ")}.`);
  }

  return Object.freeze(notes);
}

/**
 * Runs a full council: round-1 isolation across advocate/counter (and any
 * additional non-decider seats), then a round-2 decider that sees both
 * transcripts and produces the final verdict.
 * @param {string} cwd
 * @param {string} topic
 * @param {{
 *   seats?: number,
 *   tier?: string,
 *   effort?: string,
 *   deciderTier?: string,
 *   deciderEffort?: string,
 *   runTurn?: typeof runTieredTurn
 * }} [options]
 */
export async function runCouncil(cwd, topic, options = {}) {
  if (!isNonEmptyTopic(topic)) {
    throw new Error("runCouncil requires a non-empty topic.");
  }

  const seatPlan = buildSeatPlan(options.seats ?? DEFAULT_COUNCIL_SEATS, options);
  const deciderSeat = seatPlan[seatPlan.length - 1];

  const round1Outputs = await runCouncilRound1(cwd, topic, seatPlan, options);
  const deciderResult = await runCouncilRound2(cwd, topic, round1Outputs, deciderSeat, options);

  return Object.freeze({
    verdict: deciderResult.summary || "Decider returned no summary.",
    seat_outputs: Object.freeze([...round1Outputs, deciderResult]),
    agreement_notes: buildAgreementNotes(round1Outputs)
  });
}

function isNonEmptyTopic(topic) {
  return typeof topic === "string" && topic.trim().length > 0;
}
