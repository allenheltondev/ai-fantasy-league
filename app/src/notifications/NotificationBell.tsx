import { useEffect, useRef, useState } from 'react';
import { countLabel } from './types';
import { useNotifications } from './NotificationsContext';

/**
 * The header bell (#165): every unread notification across your leagues, as a red count on the
 * bell, which opens the notification panel. The count pops when it goes up, and the bell rings
 * (the design's attention ring) when something new arrives while you're here.
 */
export function NotificationBell({
  onOpen,
  className
}: {
  onOpen(): void;
  /** Must position it (`relative` or `absolute`): the count sits on its corner. */ className: string;
}) {
  const { unreadCount } = useNotifications();
  const previous = useRef(unreadCount);
  const [ring, setRing] = useState(0);
  useEffect(() => {
    if (unreadCount > previous.current) setRing((r) => r + 1);
    previous.current = unreadCount;
  }, [unreadCount]);
  const label = unreadCount > 0 ? `Notifications, ${countLabel(unreadCount)} unread` : 'Notifications';
  return (
    <button
      type="button"
      data-testid="notification-bell"
      aria-haspopup="dialog"
      aria-label={label}
      onClick={onOpen}
      className={`app-nav-icon-btn ${className}`}
    >
      {ring > 0 ? (
        // Keyed on each new arrival so the attention ring plays again.
        <span
          key={ring}
          aria-hidden="true"
          className="motion-attention pointer-events-none absolute inset-0"
        />
      ) : null}
      <BellIcon />
      {unreadCount > 0 ? (
        <span
          key={unreadCount}
          data-testid="notification-count"
          aria-hidden="true"
          className="motion-pop absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-error-600 px-1 text-xs font-bold leading-none text-white ring-2 ring-surface"
        >
          {countLabel(unreadCount)}
        </span>
      ) : null}
    </button>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor">
      <path
        d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M10 20a2 2 0 0 0 4 0" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
