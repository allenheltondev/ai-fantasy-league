import { useState } from 'react';
import { Button, Input, Select, useToast } from '@readysetcloud/ui';
import { useLeagueApi } from '../../api/league';
import type { DraftOrderMode, LeagueDetail } from '../../api/types';
import { ApiErrorAlert } from '../../components/ApiErrorAlert';

/** An ISO instant as a `datetime-local` value in this browser's time zone (`2026-09-05T19:30`). */
export function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A `datetime-local` value (this browser's time zone) as a UTC ISO instant, or null when empty. */
export function fromLocalInput(value: string): string | null {
  if (value === '') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * When the draft starts (#134): a date and time in the viewer's own time zone, stored as UTC, and
 * the order a scheduled start uses. Only the commissioner, before the draft; others see the time.
 */
export function DraftSchedulePanel({
  league,
  canEdit,
  onSaved
}: {
  league: LeagueDetail;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const api = useLeagueApi();
  const { toast } = useToast();
  const saved = league.settings.draft?.scheduledAt ?? null;
  const savedMode = league.settings.draft?.orderMode ?? 'slots';
  const [when, setWhen] = useState(toLocalInput(saved));
  const [mode, setMode] = useState<DraftOrderMode>(savedMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async (scheduledAt: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api.updateSettings(league.id, { draft: { scheduledAt, orderMode: mode } }, league.version);
      toast(scheduledAt === null ? 'Draft time cleared.' : 'Draft scheduled.', { variant: 'success' });
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  if (!canEdit || league.phase !== 'setup') {
    return (
      <p data-testid="draft-schedule">
        {saved === null
          ? 'The commissioner starts the draft by hand.'
          : `The draft starts ${new Date(saved).toLocaleString()} (${timeZone()}).`}
      </p>
    );
  }
  const next = fromLocalInput(when);
  const unchanged = next === saved && mode === savedMode;
  return (
    <div className="space-y-3" data-testid="draft-schedule">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          type="datetime-local"
          label={`Draft starts (${timeZone()})`}
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
        <Select label="Draft order" value={mode} onChange={(e) => setMode(e.target.value as DraftOrderMode)}>
          <option value="slots">By draft slot</option>
          <option value="random">Shuffled at the start</option>
        </Select>
      </div>
      <p className="text-sm text-muted-foreground">
        At this time the draft starts by itself; everyone gets a reminder 10 minutes before. Leave it empty to
        start the draft yourself.
      </p>
      <ApiErrorAlert error={error} />
      <div className="flex gap-2">
        <Button onClick={() => void save(next)} disabled={saving || unchanged} loading={saving}>
          Save draft time
        </Button>
        {saved !== null && (
          <Button variant="secondary" onClick={() => void save(null)} disabled={saving}>
            Clear draft time
          </Button>
        )}
      </div>
    </div>
  );
}
