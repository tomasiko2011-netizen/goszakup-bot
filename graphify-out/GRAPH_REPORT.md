# Graph Report - .  (2026-06-11)

## Corpus Check
- Corpus is ~8,072 words - fits in a single context window. You may not need a graph.

## Summary
- 124 nodes · 353 edges · 12 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.75)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Tender Webhook Core|Tender Webhook Core]]
- [[_COMMUNITY_Tender Database Layer|Tender Database Layer]]
- [[_COMMUNITY_Cron Tender Poller|Cron Tender Poller]]
- [[_COMMUNITY_Bot Command Handlers|Bot Command Handlers]]
- [[_COMMUNITY_User Onboarding & Admin|User Onboarding & Admin]]
- [[_COMMUNITY_Access & Reward Control|Access & Reward Control]]
- [[_COMMUNITY_Vercel Deployment Config|Vercel Deployment Config]]
- [[_COMMUNITY_Tender Search & Filters|Tender Search & Filters]]
- [[_COMMUNITY_Package Dependencies|Package Dependencies]]
- [[_COMMUNITY_Admin & Channel Management|Admin & Channel Management]]
- [[_COMMUNITY_Keyword Management|Keyword Management]]
- [[_COMMUNITY_Public Landing & CI|Public Landing & CI]]

## God Nodes (most connected - your core abstractions)
1. `handler()` - 34 edges
2. `getSql()` - 31 edges
3. `send()` - 24 edges
4. `mainMenu()` - 15 edges
5. `handleSearch()` - 14 edges
6. `handleStart()` - 13 edges
7. `handleAdmin()` - 12 edges
8. `handleLatest()` - 11 edges
9. `requireAccess()` - 10 edges
10. `handler()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `ensureSchema()` --calls--> `initTenderSchema()`  [EXTRACTED]
  api/webhook.js → lib/tender-db.js
- `getKeywords()` --calls--> `getUserKeywords()`  [EXTRACTED]
  api/webhook.js → lib/tender-db.js
- `addKeywordToList()` --calls--> `addUserKeyword()`  [EXTRACTED]
  api/webhook.js → lib/tender-db.js
- `getFilters()` --calls--> `getUserFilters()`  [EXTRACTED]
  api/webhook.js → lib/tender-db.js
- `handleFilterInput()` --calls--> `clearUserFilters()`  [EXTRACTED]
  api/webhook.js → lib/tender-db.js

## Import Cycles
- None detected.

## Communities (12 total, 0 thin omitted)

### Community 0 - "Tender Webhook Core"
Cohesion: 0.10
Nodes (25): ACTION_COST, answer(), BOT_USERNAME(), checkRateLimit(), config, editMessage(), ensureSchema(), _envTrim() (+17 more)

### Community 1 - "Tender Database Layer"
Cohesion: 0.25
Nodes (16): addUserKeyword(), advanceSearchOffset(), approveSocialAction(), claimSocialAction(), clearUserFilters(), getSearchCache(), getSql(), getUserFilters() (+8 more)

### Community 2 - "Cron Tender Poller"
Cohesion: 0.24
Nodes (13): BOT_TOKEN, CRON_SECRET, formatAmount(), formatLotCard(), GQL_TOKEN, gqlRequest(), handler(), pageLotsAfter() (+5 more)

### Community 3 - "Bot Command Handlers"
Cohesion: 0.39
Nodes (12): handleAbout(), handleAddKeyword(), handleChannelReward(), handleCheckChannels(), handleDeleteKeyword(), handleFilters(), handler(), handleReferralReward() (+4 more)

### Community 4 - "User Onboarding & Admin"
Cohesion: 0.29
Nodes (8): ADMIN_ID(), handleSocialDone(), handleStart(), notifyAdmin(), rewardMenu(), sanitize(), getReferralCount(), upsertUser()

### Community 5 - "Access & Reward Control"
Cohesion: 0.46
Nodes (8): checkAccess(), handleRewardMenu(), handleRewardStatus(), isAdminUser(), requireAccess(), rewardInlineKeyboard(), getActiveAccess(), isAdmin()

### Community 6 - "Vercel Deployment Config"
Cohesion: 0.25
Nodes (7): maxDuration, maxDuration, crons, functions, api/cron-poll.js, api/webhook.js, rewrites

### Community 7 - "Tender Search & Filters"
Cohesion: 0.33
Nodes (7): applyTenderFilters(), getFilters(), handleFilterInput(), handleLatest(), handleSearch(), searchLiveByKeywords(), searchTenders()

### Community 8 - "Package Dependencies"
Cohesion: 0.29
Nodes (6): dependencies, @neondatabase/serverless, name, private, type, version

### Community 9 - "Admin & Channel Management"
Cohesion: 0.33
Nodes (6): handleAdmin(), addChannel(), getChannels(), getPendingSocialActions(), getStats(), removeChannel()

### Community 10 - "Keyword Management"
Cohesion: 0.50
Nodes (5): addKeywordToList(), getKeywords(), handleKeywordInput(), handleMyKeywords(), deductChars()

### Community 11 - "Public Landing & CI"
Cohesion: 0.67
Nodes (3): Goszakup Telegram Bot, Goszakup Bot Redirect, CI Syntax Check Workflow

## Knowledge Gaps
- **21 isolated node(s):** `GQL_TOKEN`, `BOT_TOKEN`, `CRON_SECRET`, `UNLIMITED_IDS`, `rateLimits` (+16 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `initTenderSchema()` connect `Cron Tender Poller` to `Tender Webhook Core`, `Tender Database Layer`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `handler()` connect `Bot Command Handlers` to `Tender Webhook Core`, `Tender Database Layer`, `User Onboarding & Admin`, `Access & Reward Control`, `Tender Search & Filters`, `Admin & Channel Management`, `Keyword Management`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Why does `getSql()` connect `Tender Database Layer` to `Tender Webhook Core`, `Cron Tender Poller`, `User Onboarding & Admin`, `Access & Reward Control`, `Admin & Channel Management`, `Keyword Management`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **What connects `GQL_TOKEN`, `BOT_TOKEN`, `CRON_SECRET` to the rest of the system?**
  _21 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Tender Webhook Core` be split into smaller, more focused modules?**
  _Cohesion score 0.0960591133004926 - nodes in this community are weakly interconnected._