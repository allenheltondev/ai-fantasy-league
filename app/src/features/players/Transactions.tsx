import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle } from '@readysetcloud/ui';
import { apiFetch } from '../../api';
import { describeError, formatTime, type Transaction } from './types';

const PAGE = 20;
/** One team's moves are filtered from the league's, so read more at a time. */
const TEAM_PAGE = 50;

interface TransactionPage {
  transactions: Transaction[];
  nextCursor: string | null;
}

/** "claimed Breece Hall for $7, dropping Josh Allen". */
export function describeMove(t: Transaction): string {
  const added = t.added?.name ?? 'a player';
  const dropping = t.dropped ? `, dropping ${t.dropped.name}` : '';
  if (t.type === 'waiver_claim') return `claimed ${added} for $${t.cost ?? 0}${dropping}`;
  if (t.type === 'add') return `added ${added}${dropping}`;
  return `dropped ${t.dropped?.name ?? 'a player'}`;
}

/**
 * The league's transaction log (list_transactions), newest first, with older pages on demand. With
 * `teamId`, only that team's moves (My Team › Roster & moves, another team's page).
 */
export function Transactions({
  leagueId,
  refreshKey,
  teamId,
  title = 'Transactions'
}: {
  leagueId: string;
  refreshKey: number;
  teamId?: string;
  title?: string;
}) {
  const [items, setItems] = useState<Transaction[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let live = true;
    apiFetch<TransactionPage>(`/leagues/${leagueId}/transactions`, {
      query: { limit: teamId ? TEAM_PAGE : PAGE }
    })
      .then((res) => {
        if (!live) return;
        setItems(res.data.transactions);
        setCursor(res.data.nextCursor);
        setError(null);
      })
      .catch((err: unknown) => live && setError(describeError(err)));
    return () => {
      live = false;
    };
  }, [leagueId, refreshKey, teamId]);

  async function older(after: string) {
    setLoadingMore(true);
    try {
      const res = await apiFetch<TransactionPage>(`/leagues/${leagueId}/transactions`, {
        query: { limit: teamId ? TEAM_PAGE : PAGE, cursor: after }
      });
      setItems((current) => [...(current ?? []), ...res.data.transactions]);
      setCursor(res.data.nextCursor);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  }

  const shown = teamId === undefined ? items : items?.filter((t) => t.teamId === teamId);
  return (
    <Card role="region" aria-label={title}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-2">
        {error && <Alert variant="error">{error}</Alert>}
        {shown?.length === 0 && <p className="text-muted-foreground">No roster moves yet.</p>}
        <ol className="space-y-1" aria-label={teamId ? `${title} list` : 'League transactions'}>
          {shown?.map((t) => (
            <li key={t.id}>
              <strong>{t.teamName}</strong> {describeMove(t)}{' '}
              <span className="text-sm text-muted-foreground">
                (week {t.week}, {formatTime(t.at)})
              </span>
            </li>
          ))}
        </ol>
        {cursor !== null && (
          <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => void older(cursor)}>
            Show older moves
          </Button>
        )}
      </CardBody>
    </Card>
  );
}
