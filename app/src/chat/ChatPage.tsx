import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { Button } from '@readysetcloud/ui';
import { ApiError, apiFetch } from '../api';
import { createChatApi, type ChatApi, type ChatMessage, type ChatTeam } from './api';
import { connectMomento, type Connect } from './realtime';
import { useLeagueChat } from './useLeagueChat';

/** The league group chat (issue #71). */

export const MAX_MESSAGE_LENGTH = 1000;
const MAX_SUGGESTIONS = 6;

const defaultApi = createChatApi(apiFetch);

export function ChatPage({
  api = defaultApi,
  connect = connectMomento
}: {
  api?: ChatApi;
  connect?: Connect;
}) {
  const { leagueId = '' } = useParams();
  return <LeagueChatView key={leagueId} leagueId={leagueId} api={api} connect={connect} />;
}

function LeagueChatView({ leagueId, api, connect }: { leagueId: string; api: ChatApi; connect: Connect }) {
  const chat = useLeagueChat(leagueId, api, connect);
  const listRef = useRef<HTMLOListElement>(null);

  // Keep the newest message in view.
  useEffect(() => {
    const list = listRef.current as HTMLOListElement;
    list.scrollTop = list.scrollHeight;
  }, [chat.messages.length]);

  return (
    <section data-testid="league-section-chat" aria-labelledby="chat-title" className="flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h2 id="chat-title" className="text-xl font-semibold">
          Chat
        </h2>
        <p className="text-sm text-muted-foreground" data-testid="chat-status">
          {chat.status === 'live'
            ? 'Live'
            : chat.status === 'polling'
              ? `Updates every ${chat.pollSeconds}s`
              : 'Loading…'}
        </p>
      </header>
      <ol
        ref={listRef}
        aria-label="Chat messages"
        className="flex max-h-[60vh] min-h-48 flex-col gap-2 overflow-y-auto rounded-md border border-border p-3"
      >
        {chat.messages.length === 0 && chat.status !== 'loading' ? (
          <li className="text-sm text-muted-foreground">No messages yet. Say hi, or talk some trash.</li>
        ) : null}
        {chat.messages.map((m) => (
          <MessageItem key={m.id} message={m} teams={chat.teams} />
        ))}
      </ol>
      <Composer teams={chat.teams} onSend={chat.send} />
    </section>
  );
}

function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Wraps @mentions of known teams (by name, manager, or id) in <strong>. */
export function highlightMentions(text: string, teams: readonly ChatTeam[]): ReactNode[] {
  const names = teams
    .flatMap((t) => [t.name, t.ownerName ?? '', t.id])
    .filter((n) => n.trim().length > 0)
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (names.length === 0) return [text];
  const pattern = new RegExp(`(@(?:${names.join('|')}))(?![\\p{L}\\p{N}_])`, 'giu');
  return text.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold text-primary-700">
        {part}
      </strong>
    ) : (
      part
    )
  );
}

function MessageItem({ message, teams }: { message: ChatMessage; teams: readonly ChatTeam[] }) {
  if (message.kind === 'system') {
    return (
      <li
        data-kind="system"
        className="self-center rounded-md bg-muted px-3 py-1 text-center text-sm italic text-muted-foreground"
      >
        <span className="sr-only">League: </span>
        {message.text}
      </li>
    );
  }
  return (
    <li data-kind={message.kind} className="flex flex-col">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-semibold">{message.author.name}</span>
        {message.author.teamName !== null && message.author.teamName !== message.author.name ? (
          <span className="text-muted-foreground">{message.author.teamName}</span>
        ) : null}
        {message.kind === 'agent' ? (
          <span className="rounded bg-primary-100 px-1 text-xs font-medium text-primary-800">AI</span>
        ) : null}
        <time dateTime={message.createdAt} className="text-xs text-muted-foreground">
          {time(message.createdAt)}
        </time>
      </div>
      <p className="whitespace-pre-wrap break-words">{highlightMentions(message.text, teams)}</p>
    </li>
  );
}

/** The `@partial` being typed at the caret, if any. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^@\n]{0,30})$/.exec(before);
  if (match === null) return null;
  return { start: before.length - (match[2] as string).length - 1, query: match[2] as string };
}

/** Teams whose name or manager starts with what was typed. A name typed in full needs no suggestion. */
export function suggestTeams(teams: readonly ChatTeam[], query: string): ChatTeam[] {
  const q = query.toLowerCase();
  return teams
    .filter((t) => t.name.toLowerCase() !== q)
    .filter((t) => t.name.toLowerCase().startsWith(q) || (t.ownerName ?? '').toLowerCase().startsWith(q))
    .slice(0, MAX_SUGGESTIONS);
}

function Composer({ teams, onSend }: { teams: readonly ChatTeam[]; onSend(text: string): Promise<void> }) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  const mention = mentionQuery(text, caret);
  const suggestions = mention === null || dismissed ? [] : suggestTeams(teams, mention.query);
  const open = suggestions.length > 0;

  // Suggestions (and so `choose`) only exist while a mention is being typed.
  const choose = (team: ChatTeam) => {
    const start = (mention as { start: number }).start;
    const next = `${text.slice(0, start)}@${team.name} ${text.slice(caret)}`;
    const nextCaret = start + team.name.length + 2;
    setText(next);
    setCaret(nextCaret);
    setActive(0);
    requestAnimationFrame(() => input.current?.setSelectionRange(nextCaret, nextCaret));
  };

  const send = async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(trimmed);
      setText('');
      setCaret(0);
    } catch (e) {
      setError(e instanceof ApiError ? (e.fix ?? e.message) : 'Could not send your message. Try again.');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + suggestions.length) % suggestions.length);
      return;
    }
    if (open && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      choose(suggestions[Math.min(active, suggestions.length - 1)] as ChatTeam);
      return;
    }
    if (open && e.key === 'Escape') {
      setDismissed(true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <form
      className="relative flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label htmlFor="chat-input" className="sr-only">
        Message
      </label>
      <textarea
        id="chat-input"
        ref={input}
        rows={2}
        maxLength={MAX_MESSAGE_LENGTH}
        value={text}
        placeholder="Message the league. Type @ to mention a team."
        className="w-full resize-none rounded-md border border-border bg-background p-2"
        aria-autocomplete="list"
        aria-controls={open ? 'chat-mentions' : undefined}
        aria-expanded={open}
        role="combobox"
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setDismissed(false);
          setActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul
          id="chat-mentions"
          role="listbox"
          aria-label="Mention a team"
          className="absolute bottom-full mb-1 w-64 rounded-md border border-border bg-background shadow"
        >
          {suggestions.map((team, i) => (
            <li
              key={team.id}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-3 py-1 text-sm ${i === active ? 'bg-primary-100' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(team);
              }}
            >
              {team.name}
              {team.ownerName === null ? null : (
                <span className="text-muted-foreground"> · {team.ownerName}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
        <span className="text-xs text-muted-foreground">
          {text.length}/{MAX_MESSAGE_LENGTH}
        </span>
        <Button type="submit" variant="primary" disabled={sending || text.trim().length === 0}>
          Send
        </Button>
      </div>
    </form>
  );
}
