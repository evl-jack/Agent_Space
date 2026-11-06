# Agent Space

A local workspace with three roles: **you → Lead → Runner**, and **you → Reporter**. The Reporter responds only when asked. Each project has its own folder, brief, activity, messages, and limits.

This is a Windows-first prototype using the installed Codex App Server. There are no npm dependencies. Private project records stay under the ignored `.local/` directory and are never part of the plugin package or repository.

Agent display names are editable in **Project settings**. Each project saves its own Lead, Runner, and Reporter names; permissions and direction of work remain attached to the roles.

Each role also has a **performance** selector for reasoning effort, independent of its model. Choices come from the signed-in account's model catalog, and unsupported combinations are rejected before saving. The selected effort is sent on that role's next model turn. Defaults preserve the original behavior: high for the Lead and low for the Runner and Reporter. Deeper reasoning may take longer or use more credits; it is not a guaranteed quality improvement.

## Run

Requires Node.js 22 or later, a current Codex installation signed in to your account, and compatible Windows MXC execution support.

```powershell
node scripts/launch.mjs
```

Extract the entire ZIP first, then double-click `Start.cmd`. The launcher finds Node on PATH or in the existing Codex bundled runtime, and finds the Codex desktop executable even when Explorer's PATH lacks it. It opens the authenticated local dashboard. Set `CODEX_PATH` for a different Codex installation. Set `AGENT_SPACE_PORT` to change the preferred port, 4317.

If the preferred port belongs to another copy, the launcher selects a free local port. Launching the same running copy again reopens its session. Keep its command window open while using the app. Startup errors remain visible; details are saved privately in `.local/launch-error.log`.

On Windows, the launcher opens a dedicated app-style window using installed Chrome or Edge, without normal browser tabs or an address bar. The local server and project data are the same as in browser mode. This is a browser-engine window, not a separately installed native executable. Set `AGENT_SPACE_WINDOW_MODE=browser` to use a normal browser tab instead; browser mode is also the fallback if neither supported browser is installed.

1. Add an existing project folder and explicitly approve its boundary.
2. Check the Codex connection. This discovers your account and model catalog without starting generation.
3. Review the project brief, models, limits, and source-chat option.
4. Enable live tasks only when ready. This switch alone makes no model request.
5. Give the Lead a task or ask the Reporter a question.

All model-generated work uses the signed-in Codex connection. Model catalog access does not guarantee a successful live run. Exact subscription-credit charges are not exposed by this application, and lower total usage has not yet been established. There is no separate OpenAI API key configuration in this prototype.

## Project history

Compact handoff is the default: the Lead gets the project brief and a bounded activity excerpt. An optional **native fork** creates an in-memory fork of an existing Codex chat when a live Lead task starts. The source is not resumed or modified. Native forks can carry substantially more context. The source chat ID and brief are private project settings, not versioned application code.

Native forks omit persistent goal-continuation settings, which are incompatible with temporary forks. Automatic goals are disabled for team threads; the application controls task initiation and limits.

## Controls and limits

- The Lead plans and reviews. Its structured response decides whether the application assigns work to the Runner.
- The Runner has checked project file tools and an isolated command tool. The Reporter has only read tools.
- Inherited apps, MCP servers, plugins, built-in shell tools, web search, and built-in agent spawning are disabled for team threads. Native agent permissions remain read-only; the Runner command tool selects the separate project execution profile.
- Profiles deny broad filesystem reads and use explicit approved folders and runtime roots. The app selects Windows MXC explicitly and fails closed when the platform cannot enforce the profile. It does not silently fall back to broader legacy access.
- Command execution has no network access. Repository metadata and application-local records are excluded. Git write/network tools are intentionally not included in this version; ordinary push support remains a later milestone.
- Additional native permission requests are declined and recorded. Use **Approved spaces** to explicitly add folders with read-only or read/write access. Task permission applies to a selected running task or the next Lead task and expires when it finishes. Session permission ends when the app stops. Project permission is saved. Historical permission text is not automatically executable authority.
- A task has a token stop threshold, a wall-clock limit, and a maximum number of Runner assignments. There are no automatic task retries. Token updates can arrive after usage occurs, so the threshold is not a guaranteed billing cap.
- Stop closes the task's owned Codex process tree. File-tool writes save checkpoints. Restoring a checkpoint refuses to overwrite newer edits. Command-based changes have no automatic file checkpoint; use version control for them.
- Model, name, and brief settings cannot change during a running task. Approved spaces can be added between file or command actions. New folders become available through checked tools and refreshed command profiles; native read-only threads retain their initial folder set until the next task. Removing access stops all project tasks and closes their owned processes before the removal is acknowledged. It does not silently replay interrupted work. Switching the visible project does not retarget a task already in progress.

The authenticated HTTP service binds only to `127.0.0.1`. It rejects other Host values, cross-origin requests, and mutations without the session's request token. The local launcher URL contains a temporary session token; do not share it. The browser removes it after signing in. `.local/connection.json` lets the local plugin read the same user's workspace and must remain private.

Path checks and a single successful boundary probe do not replace a complete security audit. Test the installed isolation implementation before enabling live file changes.

## Development checks

```powershell
node --test test/*.test.mjs
```

Tests use synthetic projects and fake Codex clients, never paid model requests. They cover project isolation, file boundaries, role authority, API session controls, delegation, and recovery behavior. Local integration probes should also verify the installed Codex protocol and actual Windows permission enforcement.

Run `node scripts/preflight.mjs` for the non-generating local integration check. It uses synthetic files to verify allowed in-project reads/writes, denied outside reads/writes, protected repository metadata, and acceptance of the temporary thread/tool schema. It never calls `turn/start`.

## Plugin component

`plugin.json`, `mcp.json`, `server/mcp.mjs`, and `skills/agent-space/SKILL.md` provide a read-only local plugin component. It exposes connection/project status and activity for one explicitly selected project. It does not automatically start the dashboard, agents, or model requests. Run the application before connecting the plugin. Packaging these files does not install the plugin in Codex.

## Implementation status

The dashboard, project store, Codex transport, role orchestration, native-fork path, checked Runner tools, Reporter read tools, local plugin component, per-agent performance controls, scoped approved folders, and stop/recovery controls are implemented. Live generation and native-fork execution require a separate opt-in integration run. Git publishing tools, exact credit accounting, and plugin installation are not implemented here.

Official references: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [permissions](https://learn.chatgpt.com/docs/permissions), and [Windows isolation](https://learn.chatgpt.com/docs/windows/windows-sandbox).

### Chat-directed controls (0.2.3)
Project settings now includes app-wide automatic task limits and file-access mode. Limits can be paused; token usage remains visible and Stop work stays available. Computer access accepts absolute paths and gives the Runner normal Windows-user read/write access across the computer without folder prompts. Lead and Reporter remain read-only. Chat boundaries guide behavior rather than enforce filesystem restrictions. Network stays disabled, so Git pushes still require separate network support. Fresh installations retain approved folders and automatic limits until explicitly changed. No model task starts when these settings change.

### Runner and output update (0.2.4)
Runner sessions now start with the writable execution profile; Lead and Reporter retain the read-only profile. The command tool accepts cwd (absolute in computer mode, or relative to a selected approved space), so commands can run directly inside Solver. A disposable-file check exercised the real Runner tools without rerunning the solver baseline.

The Lead chat scrolls inside a bounded panel and preserves your position when activity updates. The bottom Output preview opens project-relative or authorized absolute paths: code/text, CSV tables (first 100 rows), images/SVG graphs, and draggable/zoomable OBJ/STL models. File contents are displayed passively, without executing previewed code.

Ask the Reporter **Publish to GitHub: Solver/ReadMe.md and the verified result files** to enable publishing for that request. **Commit and push to GitHub: ...** is also accepted. Ordinary Reporter questions cannot publish. The publishing tool copies only explicitly selected existing files from the main project into an isolated checkout of its configured GitHub repository, commits them, and performs a normal push to the repository’s default branch. Other remote files and your source checkout/index are preserved. It never force-pushes or deletes remote files. This works when the source folder itself is not a Git checkout. Git and your existing GitHub credentials/commit identity must be available; protected branches or authorization failures are reported rather than bypassed. This explicit publish tool is a network exception; ordinary agent commands still have network disabled. Publishing was verified against a local synthetic remote, without posting test data to GitHub.

### Explicit file creation (0.2.5)
The Runner now receives create_project_file, which creates missing parent folders and a new text file while refusing to overwrite an existing file. write_project_file remains available for edits. Every Runner assignment includes its actual tool names and distinguishes custom tools from disabled built-in tools, so tool availability need not be inferred from historical reports.
