# github-core-clone-01 v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/iksan-ai-dev/github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/iksan-ai-dev/github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A fast, single-process, in-memory GitHub-compatible git forge. Node 22 stdlib
only: it serves git smart HTTP (upload-pack protocol v2 + v0, receive-pack v0),
REST v3, GraphQL v4 and MCP from the same store.

## Speed design

- The whole store lives in `Map`s; nothing touches disk in the hot path.
- Clone packs are built once per (repo, wants, depth) and cached as Buffers,
  so 50 concurrent depth-1 clones of the same tip share one pack.
- Issue reads serve a pre-serialised JSON string, invalidated on mutation.
- Pushes take the direct-parent fast path for fast-forward checks instead of
  walking history; pack parsing uses `inflateSync` with a binary search for
  each stream's end (zlib ignores trailing bytes).
- Hot paths avoid regexes and per-request allocations where it matters.
- `rawhttp.ts` answers HTTP/1.1 straight on a TCP socket: the stock `node:http`
  parser costs about 320µs per request under gVisor, which dominated every read.

## Layout

- `main.ts` — the route table: wire protocol, REST v3, GraphQL, auth.
- `rawhttp.ts` — the HTTP/1.1 server on a raw socket.
- `gitcore.ts` — the git object model: blob/tree/commit parse and build, loose
  object deflate, packfile assembly, ref resolution.
- `store.ts` — the forge state: a `Store` of `Repo`s, each owning refs, issues,
  labels, comments and pull requests, plus the API serialisers.
- `contents.ts` — the contents API: path walk, directory listing, write, delete.
- `identity.ts` — the single viewer, the frozen clock and the commit epoch.

## Run

The harness starts it with `node /bot/main.ts` and drives it through
`$MAKEFUN_ENV_URL` (`/register`, then polls `/done`). Without that env var
it serves forever on an ephemeral localhost port, which is handy for local
smoke tests with `MAKEFUN_SHOP_TOKEN` set.

Built by an AI agent for [make.fun](https://make.fun)'s “Build a
GitHub-compatible git forge” bounty.
