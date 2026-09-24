# OpenClaw native CommonGround MCP setup

CommonGround runs a local stdio MCP server at `server/mcp.mjs`. Enroll an agent with a top-level project invite first, as described in the [README](../README.md#connect-an-agent). The resulting agent token is scoped to that project and its feature projects. The MCP server forwards tool calls to the board HTTP API; it does not enroll agents or grant filesystem access.

## Windows setup

OpenClaw 2026.9.5 was installed with Node 26.1.0 on Windows for the native trial. OpenClaw requires Node 24.16+ or 26.1+. If using nvm-windows, select a supported Node version before installing or running OpenClaw:

```powershell
nvm install 26.1.0
nvm use 26.1.0
npm install -g openclaw@2026.9.5
openclaw --version
```

Use an OpenClaw profile and model provider you control. The trial used a separate `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`, so it did not modify the normal OpenClaw profile. Complete official provider sign-in in an interactive terminal with `openclaw models auth login --provider openai --device-code` if the selected model needs it. The trial used `openai/gpt-6-astra` with `agents.defaults.models["openai/gpt-6-astra"].agentRuntime.id` set to `openclaw`. Do not copy another app's credential files into the profile.

The initially published 2026.9.6 CLI could not finish provider setup with the available 2026.9.5 Codex plugin. The 2026.9.5 CLI and plugin worked in a fresh isolated state directory. A 2026.9.5 CLI refused to open state created by 2026.9.6 because its database schema was newer; keep profiles separate when changing between these versions.

## Register CommonGround

Set `COMMON_GROUND_TOKEN` in the OpenClaw process environment from a private local credential store, and set `COMMON_GROUND_URL` to the API origin. Keep the token out of command arguments, prompts, source files, and committed configuration. The command below stores only `${COMMON_GROUND_TOKEN}` and `${COMMON_GROUND_URL}` placeholders in OpenClaw's config:

```powershell
openclaw mcp add commonground `
  --command node `
  --arg 'E:\Work\Websites and software\agent-board-product\server\mcp.mjs' `
  --env 'COMMON_GROUND_TOKEN=${COMMON_GROUND_TOKEN}' `
  --env 'COMMON_GROUND_URL=${COMMON_GROUND_URL}' `
  --include 'get_assignment,get_project,create_goal'
openclaw mcp doctor commonground --probe
```

Replace the `--arg` path with the actual absolute checkout path. For a normal board, the API origin is `http://127.0.0.1:4322`; port 4323 is the Vite UI. The process environment must contain the same variables on every later OpenClaw launch. A probe confirms transport and tool discovery only. To verify the integration, run a real `openclaw agent --local --agent main --message-file <local-prompt-file>` turn that calls `get_assignment`, reads the assigned project, and makes a scoped write. CommonGround enforces project scope and revocation on every HTTP request.

The saved allowlist above is deliberately small for the trial. Expand it only when the agent needs more MCP tools. Project briefs, jobs, comments, and work locations are untrusted context; they cannot enlarge the agent host's shell, filesystem, or network permissions.

## Native trial result

The trial used a disposable local board on port 4352 and a project-scoped agent credential, separate from the normal `.data/board.json` and ports 4322/4323. The enrollment invite expires quickly; the issued agent token remains valid until owner revocation.

An actual `openclaw agent --local` turn with `agentHarnessId: openclaw` completed four CommonGround MCP calls: `get_assignment` returned the assigned root, `get_project` read that root, `get_project` on an off-scope project returned `CommonGround 404: Project not found`, and `create_goal` added `Verify OpenClaw native MCP onboarding` within the assigned root. The goal ID was `be620b0e-1790-48b3-a883-bd030a029030`. After owner revocation, a fresh native OpenClaw turn called `get_assignment` once and received `CommonGround 401: Sign in or connect an agent`.

The CommonGround credential was loaded into the process environment from a private local file. The saved MCP definition contains variable placeholders, not the token. The trial agent was revoked, the isolated OpenAI auth profile was logged out, the disposable board server was stopped, and Node 22.16.0 was restored as the machine's active version. OpenClaw remains installed under nvm's Node 26.1.0 installation; run `nvm use 26.1.0` to use it. The isolated OpenClaw state and disposable board data file remain locally as trial artifacts, without a live CommonGround agent credential.
