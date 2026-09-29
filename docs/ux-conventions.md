# UX conventions

Rules for the app's pages, so new ones fit the rest without a design review. Issue #212 set
them.

## Don't repeat what the top bar or side nav says

Inside a league, the header bar's league switcher already names the league, and the side nav
marks the page you are on (and the League tab row marks its tab). So a page doesn't open with
either one:

- No league-name heading on a league page.
- No section heading that repeats the nav item ("Matchup" on Matchup, "League" above the League
  tabs, "Players" on the Players tab).
- No "Your team:" prefix on your own figures under My Team. For example, write "$100 FAAB left",
  not "Football King: $100 FAAB left".

Keep what adds information: a sub-view the nav doesn't name ("Week 4 matchups"), card titles
("Head to head"), another team's name on its page, the matchup header's teams and scores, the
chat room you're in, a phase badge. Keep a name when it disambiguates, for example the two sides
of a trade. When in doubt, ask whether someone who can see the nav would miss it.

Pages outside a league (My Leagues, Create League, Join) keep visible titles, because nothing
else on screen names them.

## Every page has exactly one `h1`

The league shell (`LeagueLayout` in `app/src/routes/pages.tsx`) renders it, visually hidden
(`sr-only`), named after the page as the nav names it ("Matchup", "Chat", "Settings" or "League
info"). A league page doesn't render its own `h1`. Its visible headings start at `h2`, and card
titles are `h3`. Pages outside a league render their own visible `h1`.

Keep landmarks, and keep `aria-current` on the nav.

## The browser tab says where you are

The tab title is `<Page> · <League> · AI Fantasy Football` inside a league, and `<Page> · AI
Fantasy Football` outside one. A sub-view with a name of its own uses that name, for example
another team's page is "Team 4 · …". `pageName()` in `app/src/layout/pageTitle.tsx` derives the
name from the route, and the shell sets it once for every page, so pages don't set
`document.title` themselves. A page with live state leads the title with a badge through
`useTitleBadge` (the draft's "⏰ Your pick · Draft · …").

A new page adds its name to `pageName()` alongside its route.

## `/` goes back to your league

Opening a league remembers it in this browser (`aff:lastLeagueId`). `/` then goes straight to
that league's Home while you're still in it. `/leagues`, the side nav's My Leagues, always shows
the list. Signing out forgets the league.
