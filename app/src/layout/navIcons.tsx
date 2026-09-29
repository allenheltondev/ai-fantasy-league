/** Line icons for the side nav (#178), drawn in the current text color. Decorative. */

import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      // Inline so AppNav's icon slot (which fills its SVGs) keeps these as outlines.
      style={{ fill: 'none' }}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const LeaguesIcon = () => (
  <Icon>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Icon>
);

export const CreateIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8.5v7M8.5 12h7" />
  </Icon>
);

export const HomeIcon = () => (
  <Icon>
    <path d="M4 11.5 12 5l8 6.5" />
    <path d="M6 10v9h12v-9" />
    <path d="M10 19v-5h4v5" />
  </Icon>
);

export const DraftIcon = () => (
  <Icon>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M4 9.5h16M4 14.5h16M9.5 4v16M14.5 4v16" />
  </Icon>
);

export const ChatIcon = () => (
  <Icon>
    <path d="M5 5h14v10H10l-4 4v-4H5Z" />
    <path d="M8.5 9.5h7M8.5 12h4" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="2.8" />
    <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6" />
  </Icon>
);

export const InfoIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </Icon>
);
export const LineupIcon = () => (
  <Icon>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="5" cy="6" r="1.2" />
    <circle cx="5" cy="12" r="1.2" />
    <circle cx="5" cy="18" r="1.2" />
  </Icon>
);

export const MatchupIcon = () => (
  <Icon>
    <path d="M5 5l6 6M11 5l-6 6M13 13l6 6M19 13l-6 6" />
  </Icon>
);

export const MovesIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
    <circle cx="12" cy="12" r="8.5" />
  </Icon>
);

export const TradesIcon = () => (
  <Icon>
    <path d="M7 7h11l-3-3M18 7l-3 3M17 17H6l3 3M6 17l3-3" />
  </Icon>
);

export const AchievementsIcon = () => (
  <Icon>
    <path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8Z" />
  </Icon>
);

export const ProfileIcon = () => (
  <Icon>
    <circle cx="12" cy="9" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Icon>
);

export const TeamsIcon = () => (
  <Icon>
    <circle cx="9" cy="9" r="3" />
    <circle cx="16.5" cy="10" r="2.5" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M14 19a4.5 4.5 0 0 1 6.5-4" />
  </Icon>
);

export const ScoreboardIcon = () => (
  <Icon>
    <rect x="3.5" y="6" width="17" height="12" rx="2" />
    <path d="M12 6v12M7 10.5h.01M7 13.5h.01M17 10.5h.01M17 13.5h.01" />
  </Icon>
);

export const StandingsIcon = () => (
  <Icon>
    <path d="M5 20v-7h4v7M10 20V5h4v15M15 20v-10h4v10M3.5 20h17" />
  </Icon>
);

export const PlayoffsIcon = () => (
  <Icon>
    <path d="M4 5h4v4H4ZM4 15h4v4H4ZM16 10h4v4h-4Z" />
    <path d="M8 7h3v10H8M11 12h5" />
  </Icon>
);

export const TransactionsIcon = () => (
  <Icon>
    <path d="M6 4h12v16l-3-2-3 2-3-2-3 2Z" />
    <path d="M9 9h6M9 13h6" />
  </Icon>
);

export const PlayersIcon = () => (
  <Icon>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5 5" />
  </Icon>
);
