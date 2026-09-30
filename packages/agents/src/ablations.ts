/**
 * Evaluation ablations (epic #219): switch off one part of the managers' new state so a matched
 * run can be compared with the full runtime (`packages/sim/src/eval/baseline.ts`). Production never
 * passes any, and with none every task runs exactly as it does without this module.
 *
 * - `no_agenda_commitments`: no agenda (#214) is read or written, and no chat commitment (#215)
 *   is opened or reviewed. A trade pitch in chat takes #196's plain follow-up instead.
 * - `no_situation`: no situational modifiers (#217); every lever is the archetype's baseline.
 * - `no_attachments`: attachments (#216) are not read, so no premium, override, or admission.
 *   Ingestion still records them; nothing uses them.
 * - `no_social_acts`: no social-act selection (#218): no question hand-off and no grounded act;
 *   a check-in's board roll goes back to league news.
 */
export const AGENT_ABLATIONS = [
  'no_agenda_commitments',
  'no_situation',
  'no_attachments',
  'no_social_acts'
] as const;
export type AgentAblation = (typeof AGENT_ABLATIONS)[number];
