import type { MemoryAudience, MemoryVisibility } from '@fantasy/core';

/**
 * A minimal persistent-participant contract (#213, ADR 009), written down from what the fantasy
 * managers already do, so a second domain can be checked against it. It is a set of seams, not a
 * framework: nothing in the fantasy runtime implements these interfaces, and nothing is extracted.
 * The shopkeeper prototype (`shopkeeper.ts`) is the only implementation.
 *
 * Lifecycle: observe -> attend -> prepare -> decide -> validate -> commit -> remember, with
 * follow-ups that are durable work, not promises in prose.
 */

/** Who the participant is: stable across model or runtime changes, scoped to a tenure. */
export interface ParticipantIdentity {
  id: string;
  displayName: string;
  /** When this occupant took the seat: state from an earlier occupant is never read. */
  tenure: string;
}

/** How it talks and how much it bends. Separate from competence (what it decides). */
export interface Disposition {
  voice: string;
  /** 0-1: how often it speaks unprompted. */
  chattiness: number;
  /** 0-1: how far a verified argument may move its own bar (never an order). */
  persuadability: number;
}

/** Something the participant saw, with who may hear about it (#206 visibility). */
export interface Observation<E> {
  id: string;
  at: string;
  event: E;
  visibility: MemoryVisibility;
}

/** Scoped memory: filtered for its audience before anything reaches a prompt. */
export interface ParticipantMemory<E> {
  remember(observation: Observation<E>): void;
  forAudience(audience: MemoryAudience): Observation<E>[];
}

/** A rule check an operation reports (the same shape for people and participants). */
export interface OperationIssue {
  code: string;
  message: string;
}

/**
 * The operation boundary: the only way anything changes. People and participants call the same
 * operations with the same validation; what a message says never grants authority.
 */
export interface Operation<S, I, O> {
  name: string;
  validate(state: S, actor: string, input: I): OperationIssue[];
  commit(state: S, actor: string, input: I): O;
}

/**
 * One capability: deterministic preparation and decision, an optional model explanation, and a
 * deterministic fallback that is the decision itself. A model may word or explain a decision; it
 * never makes one that the code did not validate.
 */
export interface Capability<P, D> {
  prepare(): P;
  decide(prep: P): D;
  /** Words for the decision; a model may produce them, the fallback always can. */
  explain(prep: P, decision: D): string;
}

/** Delivery: once-only claims so a redelivered trigger or a racing task does not act twice. */
export interface Delivery {
  claimOnce(key: string, owner: string): boolean;
  release(key: string, owner: string): void;
}
