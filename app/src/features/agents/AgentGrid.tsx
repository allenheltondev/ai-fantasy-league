import { Button, Select } from '@readysetcloud/ui';
import type { AgentCatalog, AgentSeatConfig } from '../../api/types';
import { AgentCard } from './AgentCard';
import { otherNames } from './agentConfig';

export interface AgentSeatItem {
  key: string;
  label: string;
  config: AgentSeatConfig;
}

export interface AgentGridEditor {
  onChange: (index: number, config: AgentSeatConfig) => void;
  onShuffle: (index: number) => void;
  onRandomizeAll: () => void;
  onDifficultyAll: (difficulty: string) => void;
}

export interface AgentGridProps {
  seats: AgentSeatItem[];
  catalog: AgentCatalog;
  busy?: boolean;
  /** Leave out for a read-only grid. */
  editor?: AgentGridEditor;
}

/** The AI manager cards, with "Randomize all" (new personalities, names, and avatars) and one difficulty for every card. */
export function AgentGrid({ seats, catalog, busy = false, editor }: AgentGridProps) {
  return (
    <div className="space-y-4">
      {editor && (
        <div className="flex flex-wrap items-end gap-3">
          <Button variant="secondary" loading={busy} onClick={editor.onRandomizeAll}>
            Randomize all
          </Button>
          <div className="w-full sm:w-auto sm:min-w-48">
            <Select
              label="Difficulty for all"
              value=""
              disabled={busy}
              onChange={(e) => editor.onDifficultyAll(e.target.value)}
            >
              <option value="" disabled>
                Choose…
              </option>
              {catalog.difficulties.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.displayName}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {seats.map((seat, index) => (
          <AgentCard
            key={seat.key}
            seatLabel={seat.label}
            config={seat.config}
            catalog={catalog}
            takenNames={otherNames(
              seats.map((s) => s.config),
              index
            )}
            busy={busy}
            {...(editor
              ? {
                  onChange: (config: AgentSeatConfig) => editor.onChange(index, config),
                  onShuffle: () => editor.onShuffle(index)
                }
              : {})}
          />
        ))}
      </div>
    </div>
  );
}
