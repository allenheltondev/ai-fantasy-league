import { useState } from 'react';
import { dmRoomId, type ChatRoom, type ChatTeam } from './api';

/**
 * The chat rooms (#144), in three sections: the league's rooms, this week's matchups, and your
 * direct messages, with unread badges, a "New message" picker to DM any other team, and past weeks'
 * archived matchup rooms behind a disclosure. Used as the desktop sidebar and inside the mobile
 * room sheet; every row is a 44px tap target.
 */
export function RoomList({
  rooms,
  currentRoomId,
  teams,
  yourTeamId,
  onSelect,
  loadPastWeek
}: {
  rooms: readonly ChatRoom[];
  currentRoomId: string;
  teams: readonly ChatTeam[];
  yourTeamId: string | null;
  onSelect(roomId: string, room?: ChatRoom): void;
  /** That past week's matchup rooms (archived). */
  loadPastWeek(week: number): Promise<ChatRoom[]>;
}) {
  const fixed = rooms.filter((r) => r.kind === 'fixed');
  const matchups = rooms.filter((r) => r.kind === 'matchup' && !r.archived);
  const dms = rooms.filter((r) => r.kind === 'dm');
  const currentWeek = Math.max(0, ...matchups.map((r) => r.week ?? 0));
  const liveWeeks = new Set(matchups.map((r) => r.week));
  const pastWeeks = Array.from(
    { length: Math.max(0, currentWeek - 1) },
    (_, i) => currentWeek - 1 - i
  ).filter((w) => !liveWeeks.has(w));
  const row = (room: ChatRoom) => (
    <RoomRow key={room.roomId} room={room} current={room.roomId === currentRoomId} onSelect={onSelect} />
  );
  return (
    <nav aria-label="Chat rooms" className="flex min-w-0 flex-col gap-4">
      <Section title="Rooms">{fixed.map(row)}</Section>
      {matchups.length > 0 ? <Section title="This week's matchups">{matchups.map(row)}</Section> : null}
      <Section title="Direct messages">
        {dms.map(row)}
        {yourTeamId === null ? null : (
          <li>
            <NewMessage
              teams={teams.filter((t) => t.id !== yourTeamId)}
              onPick={(teamId) => onSelect(dmRoomId(yourTeamId, teamId))}
            />
          </li>
        )}
      </Section>
      {pastWeeks.length > 0 ? (
        <PastWeeks weeks={pastWeeks} currentRoomId={currentRoomId} onSelect={onSelect} load={loadPastWeek} />
      ) : null}
    </nav>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

function RoomRow({
  room,
  current,
  onSelect
}: {
  room: ChatRoom;
  current: boolean;
  onSelect(roomId: string, room?: ChatRoom): void;
}) {
  const unread = current ? 0 : room.unreadCount;
  return (
    <li>
      <button
        type="button"
        data-room={room.roomId}
        aria-current={current ? 'page' : undefined}
        onClick={() => onSelect(room.roomId, room)}
        className={`flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 text-left text-sm ${
          current ? 'bg-primary-100 font-semibold text-primary-800' : 'hover:bg-muted'
        } ${unread > 0 ? 'font-semibold' : ''}`}
      >
        <span className="truncate">
          {room.kind === 'fixed' ? '# ' : ''}
          {room.title}
        </span>
        {unread > 0 ? <UnreadBadge count={unread} /> : null}
      </button>
    </li>
  );
}

export function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      data-testid="unread-badge"
      aria-label={`${count >= 100 ? '99+' : count} unread`}
      className="shrink-0 rounded-full bg-primary-600 px-2 py-0.5 text-xs font-semibold text-white"
    >
      {count >= 100 ? '99+' : count}
    </span>
  );
}

function NewMessage({ teams, onPick }: { teams: readonly ChatTeam[]; onPick(teamId: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm text-primary-700 hover:bg-muted"
      >
        + New message
      </button>
      {open ? (
        <ul aria-label="Message a team" className="flex flex-col gap-0.5 pl-2">
          {teams.map((team) => (
            <li key={team.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(team.id);
                }}
                className="flex min-h-11 w-full min-w-0 items-center rounded-md px-2 text-left text-sm hover:bg-muted"
              >
                <span className="truncate">
                  {team.name}
                  {team.ownerName === null ? null : (
                    <span className="text-muted-foreground"> · {team.ownerName}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PastWeeks({
  weeks,
  currentRoomId,
  onSelect,
  load
}: {
  weeks: readonly number[];
  currentRoomId: string;
  onSelect(roomId: string, room?: ChatRoom): void;
  load(week: number): Promise<ChatRoom[]>;
}) {
  const [open, setOpen] = useState(false);
  const [week, setWeek] = useState<number | null>(null);
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const pick = (w: number) => {
    setWeek(w);
    setRooms([]);
    load(w).then(
      (found) => setRooms(found.filter((r) => r.kind === 'matchup' && r.week === w)),
      () => setRooms([])
    );
  };
  return (
    <section className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center rounded-md px-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted"
      >
        Past weeks
      </button>
      {open ? (
        <>
          <div className="flex flex-wrap gap-1 px-2">
            {weeks.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={week === w}
                onClick={() => pick(w)}
                className={`min-h-11 min-w-11 rounded-md border border-border px-2 text-sm ${
                  week === w ? 'bg-primary-100 text-primary-800' : 'hover:bg-muted'
                }`}
              >
                Wk {w}
              </button>
            ))}
          </div>
          <ul className="flex flex-col gap-0.5">
            {rooms.map((room) => (
              <RoomRow
                key={room.roomId}
                room={room}
                current={room.roomId === currentRoomId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
