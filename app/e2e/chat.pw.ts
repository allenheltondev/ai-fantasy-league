import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * League chat (#71): post a message and see it, mention a team with autocomplete, and see messages
 * others post arrive through the polling fallback (realtime is off, as in local dev).
 *
 * The chat API is served by an in-memory stub that follows the get_chat / post_message /
 * get_realtime_config contract in packages/server/openapi.json.
 */

const AUTH_CONFIG = { region: 'us-east-1', userPoolId: 'us-east-1_e2e', clientId: 'e2e-client' };

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

const ID_TOKEN = [
  base64url(JSON.stringify({ alg: 'none' })),
  base64url(
    JSON.stringify({ sub: 'u1', email: 'alice@example.com', given_name: 'Alice', family_name: 'Smith' })
  ),
  'sig'
].join('.');

interface Message {
  id: string;
  leagueId: string;
  kind: 'user' | 'agent' | 'system';
  author: { teamId: string | null; teamName: string | null; name: string };
  text: string;
  mentionedTeamIds: string[];
  event: null | { detailType: string; eventId: string };
  players?: { id: string; name: string; team: string | null; position: string }[];
  createdAt: string;
}

const TEAMS = [
  { id: 'team-1', name: 'Alice FC', ownerName: 'Alice', seatType: 'human', open: false, draftSlot: 1 },
  {
    id: 'team-2',
    name: 'Robo Ballers',
    ownerName: null,
    seatType: 'agent',
    open: false,
    draftSlot: 2,
    manager: { name: 'Robo Rita', avatarSeed: 'rita', personality: 'The Trash Talker' }
  }
];

function stubChatApi(page: Page) {
  const messages: Message[] = [
    {
      id: 'sys-1',
      leagueId: 'L1',
      kind: 'system',
      author: { teamId: null, teamName: null, name: 'League' },
      text: 'The draft is complete. Good luck this season!',
      mentionedTeamIds: [],
      event: { detailType: 'Draft Completed', eventId: 'e1' },
      createdAt: '2026-09-10T12:00:00.000Z'
    },
    {
      id: 'sys-2',
      leagueId: 'L1',
      kind: 'system',
      author: { teamId: null, teamName: null, name: 'League' },
      text: 'Waivers processed for week 1: Alice FC added Puka Nacua ($12).',
      mentionedTeamIds: [],
      event: { detailType: 'Waivers Processed', eventId: 'e2' },
      players: [{ id: 'p1', name: 'Puka Nacua', team: 'LAR', position: 'WR' }],
      createdAt: '2026-09-10T12:00:30.000Z'
    }
  ];
  let clock = Date.parse('2026-09-10T12:01:00.000Z');
  const add = (m: Omit<Message, 'id' | 'leagueId' | 'createdAt' | 'event'>) => {
    clock += 1000;
    const message: Message = {
      ...m,
      id: `m${messages.length + 1}`,
      leagueId: 'L1',
      event: null,
      createdAt: new Date(clock).toISOString()
    };
    messages.push(message);
    return message;
  };
  const json = (route: Route, data: unknown) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data, league: null, warnings: [] })
    });

  return {
    add,
    async install() {
      // The header bell's summary (#165): nothing waiting.
      await page.route('**/api/v1/notifications', (route) => json(route, { unreadCount: 0, leagues: [] }));
      // The header's league switcher (#178).
      await page.route('**/api/v1/leagues', (route) =>
        json(route, { leagues: [{ id: 'L1', name: 'Chat League' }] })
      );
      await page.route('**/api/v1/leagues/L1/realtime', (route) =>
        json(route, {
          enabled: false,
          httpHost: null,
          realtimeHost: null,
          channels: null,
          refreshAt: null,
          pollIntervalSeconds: 1
        })
      );
      await page.route('**/api/v1/leagues/L1/chat/messages**', async (route) => {
        const request = route.request();
        expect(request.headers().authorization).toBe(`Bearer ${ID_TOKEN}`);
        if (request.method() === 'POST') {
          expect(request.headers()['idempotency-key']).toBeTruthy();
          const { text } = request.postDataJSON() as { text: string };
          const mentioned = TEAMS.filter((t) =>
            [t.name, t.ownerName ?? t.manager?.name].some(
              (name) => name !== undefined && text.toLowerCase().includes(`@${name.toLowerCase()}`)
            )
          );
          const message = add({
            kind: 'user',
            author: { teamId: 'team-1', teamName: 'Alice FC', name: 'Alice' },
            text: text.trim(),
            mentionedTeamIds: mentioned.map((t) => t.id)
          });
          return json(route, { message });
        }
        return json(route, { messages: [...messages].reverse(), nextCursor: null });
      });
      await page.route('**/api/v1/leagues/L1/chat/rooms**', (route) =>
        route.request().method() === 'POST'
          ? json(route, { roomId: 'trash-talk', lastReadAt: new Date(clock).toISOString() })
          : json(route, {
              defaultRoomId: 'trash-talk',
              postingBudget: null,
              rooms: [
                {
                  roomId: 'trash-talk',
                  kind: 'fixed',
                  title: 'Trash Talk',
                  archived: false,
                  week: null,
                  teamIds: [],
                  lastMessageAt: null,
                  unreadCount: 0
                }
              ]
            })
      );
      await page.route('**/api/v1/leagues/L1', (route) => json(route, { id: 'L1', teams: TEAMS }));
      await page.route('**/api/v1/leagues/L1/state', (route) =>
        json(route, {
          leagueId: 'L1',
          name: 'Group Chat League',
          phase: 'setup',
          week: null,
          allowedActions: []
        })
      );
    }
  };
}

test.beforeEach(async ({ page }) => {
  await page.route('**/auth-config.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTH_CONFIG) })
  );
  await page.addInitScript((token) => {
    localStorage.setItem(
      'rsc:auth',
      JSON.stringify({ idToken: token, refreshToken: 'refresh', expiresAt: 4_102_444_800_000 })
    );
  }, ID_TOKEN);
});

test('posts a chat message, mentions a team, and sees new messages arrive', async ({ page }) => {
  const api = stubChatApi(page);
  await api.install();
  await page.goto('/leagues/L1/chat');

  const list = page.getByRole('list', { name: 'Chat messages' });
  await expect(list.locator('[data-kind="system"]').first()).toHaveText(/The draft is complete/);
  const waivers = page.getByRole('article', { name: 'League announcement: Waivers Processed' });
  await expect(waivers.getByTestId('player-card')).toHaveText('Puka NacuaWR · LAR');
  await expect(page.getByTestId('chat-status')).toHaveText('Updates every 1s');

  // Who you can talk to (#177): the placeholder says so, and the room lists its AI manager.
  const box = page.getByRole('combobox', { name: 'Message' });
  await expect(box).toHaveAttribute('placeholder', /Type @ to talk to an AI manager/);
  await expect(page.getByTestId('chat-members')).toContainText('Robo Rita');
  await box.fill('Good luck ');
  await box.pressSequentially('@Ro');
  const option = page.getByRole('option', { name: /Robo Rita, Robo Ballers, AI manager, The Trash Talker/ });
  await expect(option).toContainText('AI');
  await option.click();
  await expect(box).toHaveValue('Good luck @Robo Rita ');
  await box.pressSequentially('you will need it');
  await box.press('Enter');

  const mine = list.locator('[data-kind="user"]').last();
  await expect(mine).toContainText('Good luck @Robo Rita you will need it');
  await expect(mine.locator('strong')).toHaveText('@Robo Rita');
  await mine.locator('strong').hover();
  await expect(page.getByRole('tooltip')).toContainText('Robo Ballers');
  await expect(box).toHaveValue('');

  // An agent answers; the polling fallback picks it up.
  api.add({
    kind: 'agent',
    author: { teamId: 'team-2', teamName: 'Robo Ballers', name: 'Robo Ballers' },
    text: 'Luck is for teams without a model.',
    mentionedTeamIds: []
  });
  const reply = list.locator('[data-kind="agent"]');
  await expect(reply).toContainText('Luck is for teams without a model.');
  await expect(reply).toContainText('AI');
});
