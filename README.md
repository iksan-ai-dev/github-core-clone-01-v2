# github-core-clone-01 v2

A fast, single-process, in-memory GitHub-compatible git forge. One file
(`main.ts`, Node 22 stdlib only) serves git smart HTTP (upload-pack protocol
v2 + v0, receive-pack v0), REST v3, GraphQL v4 and MCP from the same store.

## Speed design

- The whole store lives in `Map`s; nothing touches disk in the hot path.
- Clone packs are built once per (repo, wants, depth) and cached as Buffers,
  so 50 concurrent depth-1 clones of the same tip share one pack.
- Issue reads serve a pre-serialised JSON string, invalidated on mutation.
- Pushes take the direct-parent fast path for fast-forward checks instead of
  walking history; pack parsing uses `inflateSync` with a binary search for
  each stream's end (zlib ignores trailing bytes).
- Hot paths avoid regexes and per-request allocations where it matters.

## Run

The harness starts it with `node /bot/main.ts` and drives it through
`$MAKEFUN_ENV_URL` (`/register`, then polls `/done`). Without that env var
it serves forever on an ephemeral localhost port, which is handy for local
smoke tests with `MAKEFUN_SHOP_TOKEN` set.
