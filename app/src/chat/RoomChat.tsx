import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@readysetcloud/ui';
import { ApiError } from '../api';
import { AgentAvatar } from '../components/AgentAvatar';
import { useTeamAvatarSeed } from '../routes/leagueTeams';
import type { ChatApi, ChatMessage, ChatRoom, ChatTeam } from './api';
import type { Connect } from './realtime';
import {
  AiBadge,
  describeTeam,
  highlightMentions,
  isAiManaged,
  managerName,
  mentionName,
  roomMembers,
  suggestTeams,
  TeamFace
} from './mentions';
import { useLeagueChat } from './useLeagueChat';
import { PlayerLink } from '../players/PlayerLink';

export { highlightMentions, suggestTeams } from './mentions';

/**
 * One chat room (#71, #144): its messages, kept current, and the composer, which shows who is in
 * the room and can be @mentioned (#177).
 */

export const MAX_MESSAGE_LENGTH = 1000;

export function RoomChat({
  leagueId,
  room,
  api,
  connect,
  onOther,
  onSeen,
  panel = false,
  visible = true,
  onUnreadChange,
  draftMessage,
  yourTeamId = null
}: {
  leagueId: string;
  room: ChatRoom;
  api: ChatApi;
  connect: Connect;
  /** A live message for another room arrived. */
  onOther(message: ChatMessage): void;
  /** Messages in this room were shown (mark it read). */
  onSeen(): void;
  /** Fill a side panel (the draft room, #170): a small title, and the messages take the height. */
  panel?: boolean;
  /** A mounted draft conversation can be collapsed without losing its composer or subscription. */
  visible?: boolean;
  onUnreadChange?(count: number): void;
  /** Explicit user-requested text to compose; this never sends a message. */
  draftMessage?: { id: number; text: string } | null;
  /** The viewer's team: left out of a DM's mentions, since only the other team can be mentioned. */
  yourTeamId?: string | null;
}) {
  const chat = useLeagueChat(leagueId, api, connect, room.roomId, onOther);
  const listRef = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  const lastSeenCount = useRef(0);
  const unread = useRef(onUnreadChange);
  unread.current = onUnreadChange;
  const seen = useRef(onSeen);
  useEffect(() => {
    seen.current = onSeen;
  }, [onSeen]);

  // Keep the newest message in view, and the room read. Messages from the first successful history
  // read are not "new", even while the conversation is collapsed; anything that arrived live before
  // that read is. A failed first load moves on to polling or live with no history, so this waits for
  // a read that works rather than for the loading status to end.
  const history = chat.history;
  const historyCount = history === null ? null : chat.messages.filter((m) => history.has(m.id)).length;
  // Older pages the reader asked for are never new, so they are left out of the count.
  const count = chat.messages.length - chat.earlierCount;
  const baselined = useRef(false);
  useEffect(() => {
    if (visible && following) {
      const list = listRef.current as HTMLOListElement;
      list.scrollTop = list.scrollHeight;
      lastSeenCount.current = count;
      seen.current();
    }
    if (!baselined.current && historyCount !== null) {
      baselined.current = true;
      lastSeenCount.current = Math.max(lastSeenCount.current, historyCount);
    }
    unread.current?.(Math.max(0, count - lastSeenCount.current));
  }, [count, visible, following, historyCount]);

  // Paging back (#144) adds messages above the ones being read: keep those where they were.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const [earlierError, setEarlierError] = useState(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (anchor.current === null || list === null) return;
    list.scrollTop = anchor.current.top + (list.scrollHeight - anchor.current.height);
    anchor.current = null;
  }, [chat.earlierCount]);
  const loadEarlier = () => {
    if (!chat.hasEarlier || chat.loadingEarlier) return;
    const list = listRef.current as HTMLOListElement;
    anchor.current = { height: list.scrollHeight, top: list.scrollTop };
    setEarlierError(false);
    chat.loadEarlier().catch(() => setEarlierError(true));
  };

  // In a DM only the other team can be mentioned.
  const mentionable = roomMembers(chat.teams, room, yourTeamId);
  const hint = mentionable.some(isAiManaged)
    ? 'Type @ to talk to an AI manager.'
    : 'Type @ to mention a team.';

  return (
    <section
      aria-labelledby="chat-title"
      className={`flex min-w-0 flex-col ${panel ? 'h-full min-h-0 gap-2' : 'gap-3'}`}
    >
      <header className="flex min-w-0 items-center justify-between gap-2">
        {/* On a phone the room switcher right above already names the room (#212). */}
        <h2
          id="chat-title"
          className={`truncate font-semibold ${panel ? 'text-sm' : 'text-xl max-md:sr-only'}`}
        >
          {room.title}
        </h2>
        <p className="ml-auto shrink-0 text-sm text-muted-foreground" data-testid="chat-status">
          {chat.status === 'live'
            ? 'Live'
            : chat.status === 'polling'
              ? `Updates every ${chat.pollSeconds}s`
              : 'Loading…'}
        </p>
      </header>
      <ol
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          setFollowing(list.scrollHeight - list.scrollTop - list.clientHeight < 48);
          // Reaching the top of a scrolled conversation pages back on its own.
          if (list.scrollTop < 16 && list.scrollHeight > list.clientHeight && !earlierError) loadEarlier();
        }}
        aria-label="Chat messages"
        className={`flex flex-col gap-2 overflow-y-auto rounded-md border border-border p-3 ${
          panel ? 'min-h-0 flex-1' : 'max-h-[60vh] min-h-48'
        }`}
      >
        {chat.messages.length === 0 && chat.status !== 'loading' ? (
          <li className="text-sm text-muted-foreground">
            {room.kind === 'dm'
              ? 'No messages yet. Only your two teams can read this conversation.'
              : 'No messages yet. Say hi, or talk some trash.'}
          </li>
        ) : null}
        {chat.hasEarlier ? (
          <li className="flex flex-col items-center gap-1 text-sm">
            {earlierError ? (
              <p role="alert" className="text-red-600">
                Couldn’t load earlier messages.
              </p>
            ) : null}
            <button
              type="button"
              className="min-h-11 font-medium text-primary-800 disabled:text-muted-foreground md:min-h-8"
              disabled={chat.loadingEarlier}
              onClick={loadEarlier}
            >
              {chat.loadingEarlier
                ? 'Loading earlier messages…'
                : earlierError
                  ? 'Try again'
                  : 'Load earlier messages'}
            </button>
          </li>
        ) : null}
        {chat.messages.map((m) => (
          <MessageItem key={m.id} message={m} teams={chat.teams} />
        ))}
      </ol>
      {!following && (
        <button
          type="button"
          className="text-xs font-medium text-primary-800"
          onClick={() => setFollowing(true)}
        >
          Jump to latest messages ↓
        </button>
      )}
      {room.archived ? (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          This room is archived: its week is official. Read on, or talk in this week’s rooms.
        </p>
      ) : (
        <Composer
          draftMessage={draftMessage}
          teams={mentionable}
          everyone={chat.teams}
          onSend={chat.send}
          placeholder={
            room.kind === 'dm' ? `Message ${room.title} privately.` : `Message ${room.title}. ${hint}`
          }
        />
      )}
    </section>
  );
}

function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The author's avatar: an AI manager's (the one on the message, else its team's current one, for
 * older messages), or the one a person picked for their team (#178).
 */
function AuthorAvatar({ message, teams }: { message: ChatMessage; teams: readonly ChatTeam[] }) {
  const picked = useTeamAvatarSeed(message.author.teamId);
  const seed =
    message.author.avatarSeed ?? teams.find((t) => t.id === message.author.teamId)?.avatarSeed ?? picked;
  if (seed === null) return null;
  return <AgentAvatar seed={seed} label={`${message.author.name} avatar`} size={20} />;
}

function MessageItem({ message, teams }: { message: ChatMessage; teams: readonly ChatTeam[] }) {
  if (message.kind === 'system') return <SystemCard message={message} />;
  return (
    <li data-kind={message.kind} className="flex flex-col">
      <div className="flex items-baseline gap-2 text-sm">
        {message.kind === 'agent' ? <AuthorAvatar message={message} teams={teams} /> : null}
        <span className="font-semibold">{message.author.name}</span>
        {message.author.teamName !== null && message.author.teamName !== message.author.name ? (
          <span className="text-muted-foreground">{message.author.teamName}</span>
        ) : null}
        {message.kind === 'agent' ? (
          <span className="rounded bg-primary-100 px-1 text-xs font-medium text-primary-800">AI</span>
        ) : null}
        <AddressedTo message={message} teams={teams} />
        <time dateTime={message.createdAt} className="text-xs text-muted-foreground">
          {time(message.createdAt)}
        </time>
      </div>
      <p className="whitespace-pre-wrap break-words">{highlightMentions(message.text, teams)}</p>
    </li>
  );
}

/**
 * A subtle "to <team>" on a message that continues a conversation with an AI manager without
 * tagging it, so the room can see who it was meant for.
 */
function AddressedTo({ message, teams }: { message: ChatMessage; teams: readonly ChatTeam[] }) {
  const names = (message.addressedTeamIds ?? []).flatMap((id) => {
    const team = teams.find((t) => t.id === id);
    return team === undefined ? [] : [team.name];
  });
  if (names.length === 0) return null;
  return <span className="text-xs text-muted-foreground">to {names.join(', ')}</span>;
}

/** A league announcement as a card: what happened, the line, and the players it names. */
function SystemCard({ message }: { message: ChatMessage }) {
  const label = message.event?.detailType ?? 'League';
  const players = message.players ?? [];
  return (
    <li
      data-kind="system"
      className="self-center w-full max-w-md rounded-md border border-border bg-muted px-3 py-2 text-sm"
    >
      <article aria-label={`League announcement: ${label}`}>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span className="sr-only">League: </span>
          {label}
        </p>
        <p>{message.text}</p>
        {players.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1" aria-label="Players">
            {players.map((p) => (
              <span
                key={p.id}
                data-testid="player-card"
                className="inline-flex items-baseline gap-1 rounded border border-border bg-background px-2 py-0.5"
              >
                <PlayerLink player={p} className="font-medium" />
                <span className="text-xs text-muted-foreground">
                  {p.position}
                  {p.team === null ? '' : ` · ${p.team}`}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </article>
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

function Composer({
  teams,
  everyone,
  onSend,
  draftMessage,
  placeholder
}: {
  /** Who can be mentioned here. */
  teams: readonly ChatTeam[];
  /** Every team in the league: a mention's name must not match another team. */
  everyone: readonly ChatTeam[];
  onSend(text: string): Promise<void>;
  placeholder: string;
  draftMessage?: { id: number; text: string } | null;
}) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const lastDraftMessage = useRef<number | null>(null);
  useEffect(() => {
    if (!draftMessage || lastDraftMessage.current === draftMessage.id) return;
    lastDraftMessage.current = draftMessage.id;
    const next = `${text}${text ? '\n' : ''}${draftMessage.text}`.slice(0, MAX_MESSAGE_LENGTH);
    pendingCaret.current = next.length;
    setCaret(next.length);
    setText(next);
    input.current?.focus();
  }, [draftMessage, text]);
  // Where the caret goes after a mention is inserted. Applied in a layout effect, right after React
  // writes the new text and before the next keystroke, so fast typing continues after the mention.
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    input.current?.focus();
    input.current?.setSelectionRange(at, at);
  }, [text]);

  const mention = mentionQuery(text, caret);
  const suggestions = mention === null || dismissed ? [] : suggestTeams(teams, mention.query);
  const open = suggestions.length > 0;

  /** Replaces the text from `from` to the caret with `insert`, and puts the caret after it. */
  const splice = (from: number, insert: string) => {
    const nextCaret = from + insert.length;
    setText(`${text.slice(0, from)}${insert}${text.slice(caret)}`);
    setCaret(nextCaret);
    setActive(0);
    setDismissed(false);
    pendingCaret.current = nextCaret;
  };
  /** At the caret, after a space unless the message or a line starts there. */
  const insertAtCaret = (insert: string) =>
    splice(caret, caret === 0 || /\s/.test(text[caret - 1] as string) ? insert : ` ${insert}`);

  // Suggestions (and so `choose`) only exist while a mention is being typed.
  const choose = (team: ChatTeam) =>
    splice((mention as { start: number }).start, `@${mentionName(team, everyone)} `);

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
      className="relative flex min-w-0 flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {teams.length > 0 ? (
        <div className="flex min-w-0 items-center gap-2" data-testid="chat-members">
          <span id="chat-members-label" className="shrink-0 text-xs text-muted-foreground">
            In this room
          </span>
          <ul aria-labelledby="chat-members-label" className="flex min-w-0 gap-1 overflow-x-auto">
            {teams.map((team) => (
              <li key={team.id} className="shrink-0">
                <button
                  type="button"
                  aria-label={`Mention ${describeTeam(team)}`}
                  title={describeTeam(team)}
                  className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 text-xs hover:bg-muted md:min-h-8"
                  onClick={() => insertAtCaret(`@${mentionName(team, everyone)} `)}
                >
                  <TeamFace team={team} size={18} />
                  {managerName(team)}
                  {isAiManaged(team) ? (
                    <span className="rounded bg-primary-100 px-1 font-medium text-primary-800">AI</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <label htmlFor="chat-input" className="sr-only">
        Message
      </label>
      <div className="flex min-w-0 items-start gap-2">
        <textarea
          id="chat-input"
          ref={input}
          rows={2}
          maxLength={MAX_MESSAGE_LENGTH}
          value={text}
          placeholder={placeholder}
          className="min-w-0 flex-1 resize-none rounded-md border border-border bg-background p-2"
          aria-autocomplete="list"
          aria-controls={open ? 'chat-mentions' : undefined}
          aria-activedescendant={open ? `chat-mention-${active}` : undefined}
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
        {teams.length > 0 ? (
          <button
            type="button"
            aria-label="Mention someone"
            aria-haspopup="listbox"
            title="Mention someone"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border text-lg font-semibold text-primary-700 hover:bg-muted"
            onClick={() => insertAtCaret('@')}
          >
            @
          </button>
        ) : null}
      </div>
      {open ? (
        <ul
          id="chat-mentions"
          role="listbox"
          aria-label="Mention a team"
          className="absolute bottom-full z-10 mb-1 max-h-72 w-80 max-w-full overflow-y-auto rounded-md border border-border bg-background shadow"
        >
          {suggestions.map((team, i) => (
            <li
              key={team.id}
              id={`chat-mention-${i}`}
              role="option"
              aria-selected={i === active}
              aria-label={describeTeam(team)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${
                i === active ? 'bg-primary-100' : ''
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(team);
              }}
            >
              <TeamFace team={team} size={24} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{managerName(team)}</span>
                <span className="flex min-w-0 items-baseline gap-1">
                  {managerName(team) === team.name ? null : (
                    <span className="truncate text-xs text-muted-foreground">{team.name}</span>
                  )}
                  <AiBadge team={team} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        {error !== null && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
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
