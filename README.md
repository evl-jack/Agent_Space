# Agent Space

A Windows local workspace for three agents: **Lead** handles reasoning and review, **Runner** implements and verifies, and **Reporter** manages GitHub and project updates. Names, models, and reasoning effort are configurable per project. Project briefs, activity, and chats stay separate.

## Start

Extract the whole ZIP and open `Start.cmd`. The desktop shortcut opens your existing working copy. The launcher uses Node.js 22+ and your signed-in Codex installation, opens an app-style Chrome/Edge window, reuses a running session, and chooses a free port if necessary. Browser mode is available with `AGENT_SPACE_WINDOW_MODE=browser`. Startup errors stay visible and are logged under `.local/launch-error.log`.

Check the connection, then enable live tasks. That switch alone does not submit a model request. Stop work closes owned agent connections. Model requests use your Codex allowance; token observations are not exact credit accounting.

## Roles and handoffs (0.2.6)

- **Lead:** plans, reasons, reviews, and directs work through `runnerTask` and optional `reporterTask` in its structured response. It remains read-only.
- **Runner:** creates files and missing parent folders, edits text files, and runs argv commands with an explicit `cwd`. It performs implementation and required verification, then returns changed paths, exit codes, and concise evidence.
- **Reporter / GitHub manager:** can create and edit files, prepare documentation and repository artifacts, read project activity, send teammate messages, and commit/push selected project files. It accepts natural-language requests from you or a Lead assignment. There is no special publish-command prefix. It has no arbitrary command-execution tool. A summary-only request should produce a summary without unrequested changes.

The Lead prioritizes planning, implementation, math, debugging, and verification before GitHub housekeeping. If it returns both assignments, Runner work executes first and Reporter work is held until the Lead returns no further Runner assignment. Reporter delegation is optional: tasks without repository work do not start it. The Reporter receives the original bounds, Lead instructions, Runner handoff evidence, and project activity. Its result returns to the Lead for review and appears in both relevant chat views. Direct Reporter requests wait behind current Lead work; Reporter jobs for one project run serially.

Runner and Reporter have `read_team_activity` and `send_team_message`. Messages stay in the selected project and are delivered at the recipient's next turn or retrieved through activity. They do not start agents automatically. The Lead receives messages between turns and communicates back through its assignments. Preserve earlier verified baseline evidence; neither helper should repeat baseline runs merely to diagnose tool availability.

## GitHub publishing

Set the intended GitHub repository in Project settings. Ask the Reporter to create/update the needed files and publish them, or let the Lead delegate that repository update after primary work. The manager uses your existing Git installation, GitHub credentials, and commit identity. Protected-branch or authentication failures are reported rather than bypassed.

The publish tool copies only explicitly selected ordinary files from the main project into an isolated checkout of the configured repository, commits them, and performs a normal push to its default branch. It works even when the source folder is not a Git checkout. Other remote files and your source index are preserved. No force pushes, branch deletion, remote file deletion, or credential-file publishing. A commit link is reported only after successful push. The isolated checkout stays in ignored `.local/github/`.

Publishing is the Reporter's dedicated network exception. Ordinary agent commands still have network disabled. No scheduled/background publishing is enabled. Live publishing has been checked against a synthetic local remote; no solver files are pushed as part of app verification.

## Folder access and task controls

Fresh installations use approved folders and automatic token, duration, and Runner-assignment limits. App-wide controls in Project settings can pause those limits and enable computer-wide file access. Existing private settings survive updates when you keep `.local`.

In computer mode, Runner and Reporter can create/edit files with normal Windows-user permissions, without folder prompts. Lead remains read-only. Chat instructions guide behavior; they do not create an OS-enforced folder boundary. Approved-folder mode restricts tools to configured roots and access levels. Extra folder grants can last for a task, session, or project; revocation stops running project tasks. Folder restrictions, protected metadata, credential exclusions, symlink checks, and network isolation remain enforced in approved-folder mode.

File-tool changes have checkpoints. Restore refuses to overwrite newer edits. Command-generated changes do not have these file checkpoints. Stop does not automatically replay failed work. Model/name/brief/access settings require idle tasks; adding folders applies between actions. Selecting another visible project does not retarget existing work.

## Context and previews

A compact handoff uses the project brief. An optional private native fork gives the Lead inherited source-chat history and can substantially increase token usage. The source chat is unchanged. Automatic goals and inherited connectors/plugins are disabled in team threads.

Long chats scroll inside bounded panels. Output preview opens project-relative or authorized absolute paths: code/text, CSV tables (first 100 rows), images/SVG graphs, and draggable/zoomable OBJ/STL models. Previewed code is displayed passively, never executed.

## Verification and local plugin

Run `node --test test/*.test.mjs` for the local suite. `node scripts/preflight.mjs` checks protocol/OS boundaries without model generation. No npm dependencies are needed.

`plugin.json`, `mcp.json`, `server/mcp.mjs`, and `skills/agent-space/SKILL.md` provide a separate read-only local plugin component for status and project activity. Those external plugin tools do not start agents or modify files; the dashboard owns the writable team tools. Packaging does not install the plugin. Private `.local` data, source-chat contents, and credentials are excluded from Git and release ZIPs.
