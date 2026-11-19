# gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/hangquytu2024-cpu/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/hangquytu2024-cpu/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A small git forge in one Node process with no dependencies and no git binary. It keeps everything in memory and speaks four languages on one port:

- **git smart HTTP.** Clone, fetch and push work with a real `git` client. Fetch uses protocol v2 (`ls-refs` and `fetch`, with shallow clones and deepening), push uses `receive-pack`. Packs are read with OFS and REF deltas resolved, and written as whole objects.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents (create, update, delete with the stale sha check), labels, issues and comments, pull requests, the files of a pull request, and merges (a squash puts the change on the default branch, a conflict answers 405).
- **GraphQL v4** at `/api/graphql`, with a hand written parser and executor: queries and mutations, variables, fragments, aliases, and connections with `first`, `after`, `edges`, `nodes` and `pageInfo`.
- **MCP** at `/mcp`: `initialize`, `tools/list` and `tools/call` over JSON-RPC, with tools that read and change the same state the REST API shows.

All four sit on one store of repositories, each with its own git object database and refs, so an issue made through GraphQL shows up in REST and a file pushed with git can be read through the contents API.

A few things worth knowing about how it is built:

- Nothing reads the clock or the random number generator. Timestamps move forward one second per call from a fixed start, so two runs of the same requests give the same bytes.
- The server is told the token but never the login it belongs to, so the first owner an authenticated request names becomes the login. A repository under any other owner is a 404.
- `main.ts` is the lifecycle the bounty harness drives: bind an ephemeral port, register it with the env, wait until the env says it is done, exit 0.

## Run it

```sh
node main.ts
```

That needs `MAKEFUN_ENV_URL` to point at the suite. To poke at the server by hand: `MAKEFUN_SHOP_TOKEN=secret node serve.ts 9000`, then `git clone http://x:secret@127.0.0.1:9000/<owner>/<repo>.git`. Node 22.18 or newer, nothing to install.

## Files

- `app.ts` routes a request to the surface that owns its path. `http.ts` holds the small shared helpers.
- `store.ts` and `gitops.ts` are the shared core: repositories, objects, refs, trees, commits, diffs and merges.
- `rest.ts` and `domain.ts` are the REST layer and the business logic every surface reuses.
- `git.ts`, `pack.ts` and `pktline.ts` are the git protocol. `graphql.ts` and `gql-parser.ts` are GraphQL. `mcp.ts` is MCP.

---

<sub>Entered on [make.fun](https://make.fun/?ref=x2mfc4pb&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
