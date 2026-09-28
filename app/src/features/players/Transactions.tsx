import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, CardTitle } from '@readysetcloud/ui';
import { apiFetch } from '../../api';
import { describeError, formatTime, type Transaction } from './types';

const PAGE = 20;

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

/** The league's transaction log (list_transactions), newest first, with older pages on demand. */
export function Transactions({ leagueId, refreshKey }: { leagueId: string; refreshKey: number }) {
  const [items, setItems] = useState<Transaction[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let live = true;
    apiFetch<TransactionPage>(`/leagues/${leagueId}/transactions`, { query: { limit: PAGE } })
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
  }, [leagueId, refreshKey]);

  async function older(after: string) {
    setLoadingMore(true);
    try {
      const res = await apiFetch<TransactionPage>(`/leagues/${leagueId}/transactions`, {
        query: { limit: PAGE, cursor: after }
      });
      setItems((current) => [...(current ?? []), ...res.data.transactions]);
      setCursor(res.data.nextCursor);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Card role="region" aria-label="Transactions">
      <CardHeader>
        <CardTitle>Transactions</CardTitle>
      </CardHeader>
      <CardBody className="space-y-2">
        {error && <Alert variant="error">{error}</Alert>}
        {items?.length === 0 && <p className="text-muted-foreground">No roster moves yet.</p>}
        <ol className="space-y-1" aria-label="League transactions">
          {items?.map((t) => (
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
