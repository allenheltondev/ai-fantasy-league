import { InfoPopover } from '../../components/InfoPopover';

/**
 * A plain-language note on FAAB (free agent acquisition budget), tucked behind a small
 * question-mark icon so it stays out of the way until asked for.
 */
export function FaabExplainer({ remaining }: { remaining?: number | null }) {
  return (
    <InfoPopover label="What is FAAB?" title="About FAAB" testId="faab-explainer">
      <p>
        FAAB is your free agent budget: play money, not real money. Every team gets the same amount for the
        season{remaining != null && <> (you have ${remaining} left)</>}.
      </p>
      <p>
        Players on waivers cost a bid. Highest bid wins, and only the winner pays. Ties go to waiver priority.
        Players who are already free agents cost $0: add them any time.
      </p>
    </InfoPopover>
  );
}
