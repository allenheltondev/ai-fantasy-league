import { useState, type ReactNode } from 'react';
import { Drawer } from '@readysetcloud/ui';
import { UnreadBadge } from './RoomList';

/**
 * The phone's room switcher (#144): a top bar naming the room, with the unread count of every
 * other room, that opens the room list as a bottom sheet. `children` renders the list; it gets a
 * `close` so picking a room closes the sheet.
 */
export function RoomSwitcher({
  title,
  unread,
  children
}: {
  title: string;
  /** Unread messages in the other rooms. */
  unread: number;
  children(close: () => void): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Chat room: ${title}. Switch rooms${unread > 0 ? ` (${unread} unread)` : ''}`}
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border px-3 text-left"
      >
        <span className="truncate font-semibold">{title}</span>
        <span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          {unread > 0 ? <UnreadBadge count={unread} /> : null}
          Rooms ▾
        </span>
      </button>
      {open ? (
        <Drawer
          open
          modal
          hideTab
          side="bottom"
          size="75vh"
          title="Chat rooms"
          titleAs="h2"
          onOpenChange={(next) => setOpen(next)}
        >
          {children(() => setOpen(false))}
        </Drawer>
      ) : null}
    </div>
  );
}
