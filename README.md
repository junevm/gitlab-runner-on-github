# Ephemeral GitLab Docker Runner on GitHub Actions

Run **GitLab CI/CD pipelines on GitHub Actions VMs** using the **Docker executor**, on-demand, with complete project isolation and zero idle cost.

---

## 🎯 Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│ GitLab Project (e.g. "backend-service")                     │
│                                                             │
│  Pipeline Created (Pending)                                 │
│  Jobs:                                                      │
│  ├── Stage 1: test:unit   (image: python:3.11)              │
│  ├── Stage 1: test:lint   (image: node:20)                  │
│  └── Stage 2: docker:build (image: docker:dind)             │
└──────────────────────────────┬──────────────────────────────┘
                               │ Webhook (Pipeline event)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Cloudflare Worker (Parametric Webhook Router)               │
│                                                             │
│  POST https://bridge.workers.dev/dispatch/backend-runner    │
│  Translates webhook ──► POST /repos/org/backend-runner/...  │
└──────────────────────────────┬──────────────────────────────┘
                               │ repository_dispatch
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Dedicated GitHub Runner Repo (backend-runner)               │
│                                                             │
│  Spawns N Parallel Ephemeral VMs (vars.WORKERS = 2)         │
│                                                             │
│  ┌───────────────────────┐     ┌───────────────────────┐    │
│  │ GitHub VM Worker #1   │     │ GitHub VM Worker #2   │    │
│  │ (Docker Engine)       │     │ (Docker Engine)       │    │
│  │                       │     │                       │    │
│  │ gitlab-runner         │     │ gitlab-runner         │    │
│  │ run-single (Docker)   │     │ run-single (Docker)   │    │
│  │                       │     │                       │    │
│  │ ├─ runs test:unit     │     │ ├─ runs test:lint     │    │
│  │ └─ runs docker:build  │     │ └─ idle (35s) ──► exit│    │
│  └───────────────────────┘     └───────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔑 Core Design Principles

1. **Strict 1:1 Project Isolation**: Each GitLab project has its own dedicated GitHub runner repository and project-level runner token (`glrt-...`). Project A cannot access, see, or run jobs for Project B.
2. **Pure Docker Execution**: Every job runs inside an isolated container via `gitlab-runner run-single` with Docker-in-Docker (`docker:dind`) and Docker socket mounting.
3. **No Daemon / Watchdog Complexity (KISS)**: Uses native `run-single` execution loops. When the GitLab pipeline queue is empty for 35s, the worker exits cleanly.
4. **Configurable Multi-VM Elasticity**: Set the number of parallel VMs per project via a simple repository variable (`WORKERS`).
5. **Universal Parametric Routing**: A single Cloudflare Worker dynamically routes webhooks to any project runner repo without code changes.

---

## 🛠️ Local Development & Tooling with `mise`

This repository is preconfigured with [`mise.toml`](mise.toml) and [`mise.lock`](mise.lock) (with `lockfile = true` enabled) for pinned, reproducible toolchains (`node@lts`, `actionlint@latest`, `shellcheck@latest`) across all platforms:

```bash
# Install all pinned dev tools
mise install

# Available project tasks
mise run lint                   # Lint GitHub Actions workflows (actionlint + shellcheck)
mise run worker:dev             # Start local Cloudflare Worker development server
mise run worker:deploy          # Deploy the Cloudflare Worker bridge
mise run worker:secret:pat      # Set GH_PAT secret in Cloudflare Worker
mise run worker:secret:token    # Set GITLAB_SECRET_TOKEN secret in Cloudflare Worker
```

---

## 📋 Prerequisites

- **GitLab**: Maintainer/Owner access to your GitLab project (or group).
- **GitHub**: Account or Organization with repository creation permissions.
- **Cloudflare**: Free account (used for the zero-cost webhook bridge).
- **Local Tools**: [`mise`](https://mise.jdx.dev) (recommended) or `node` (v18+) and `npm`.

---

## 🚀 Step-by-Step Setup Guide

### Step 1: Deploy the Cloudflare Webhook Router (One-time Setup)

The Cloudflare Worker acts as the bridge between GitLab's Webhook payload and GitHub's `repository_dispatch` API.

1. **Generate a GitHub Personal Access Token (PAT)**:
   - Go to GitHub > **Settings** > **Developer Settings** > **Personal access tokens** > **Fine-grained tokens** (or Classic).
   - **Repository access**: Select *All repositories* or *Only select repositories* (your runner repos).
   - **Permissions**: `Actions` (Read and Write), `Metadata` (Read).
   - Copy the generated token (`github_pat_...`).

2. **Configure the Worker**:
   - Open [`cloudflare-worker/wrangler.toml`](cloudflare-worker/wrangler.toml).
   - Update `GH_OWNER` with your GitHub username or organization name.

3. **Deploy the Worker**:
   - Authenticate with Cloudflare:
     ```bash
     cd cloudflare-worker && npx wrangler login
     ```
   - Store your GitHub PAT as an encrypted secret in Cloudflare:
     ```bash
     mise run worker:secret:pat
     # Or: npx wrangler secret put GH_PAT (inside cloudflare-worker/)
     ```
   - *(Optional)* Set a shared secret token for webhook validation:
     ```bash
     mise run worker:secret:token
     # Or: npx wrangler secret put GITLAB_SECRET_TOKEN (inside cloudflare-worker/)
     ```
   - Deploy:
     ```bash
     mise run worker:deploy
     # Or: npx wrangler deploy (inside cloudflare-worker/)
     ```
   - Note down the published worker URL (e.g. `https://gitlab-gha-bridge.<your-subdomain>.workers.dev`).

---

### Step 2: Create a Project Runner in GitLab

1. In GitLab, navigate to your project > **Settings** > **CI/CD** > **Runners**.
2. Click **New project runner**.
3. Under **Platform**, select **Linux**.
4. Under **Tags**:
   - Specify a tag (e.g., `docker-runner`), or check **Run untagged jobs** if you want all pipeline jobs to use this runner.
5. Click **Create runner**.
6. Copy the displayed **Runner authentication token** (starts with `glrt-...`).  
   *(Note: This token is shown only once).*

---

### Step 3: Create the Dedicated GitHub Runner Repository

1. On GitHub, create a new private repository for this project's runner (e.g., `my-project-runner`).
2. Add the caller workflow file to the repo at [`.github/workflows/runner.yml`](.github/workflows/runner.yml):
   - Copy the contents from this repository's [`.github/workflows/runner.yml`](.github/workflows/runner.yml).
   - Update the `uses:` reference to point to this central repository:
     ```yaml
     uses: <YOUR_CENTRAL_ORG>/gitlab-runner-on-github/.github/workflows/reusable-runner.yml@main
     ```
3. Configure Secrets in the runner repo:
   - Go to **Settings** > **Secrets and variables** > **Actions** > **Secrets** tab.
   - Click **New repository secret**:
     - Name: `GITLAB_RUNNER_TOKEN`
     - Value: Paste the `glrt-...` token from Step 2.
   - *(Optional)* If using a self-hosted GitLab instance, add `GITLAB_URL` (e.g., `https://gitlab.example.com`). Defaults to `https://gitlab.com` if omitted.

---

### Step 4: Configure Concurrency / Elasticity

To control how many parallel GitHub Actions VMs boot for this project:

1. In your project runner repository on GitHub:
   - Go to **Settings** > **Secrets and variables** > **Actions** > **Variables** tab.
2. Click **New repository variable**:
   - Name: `WORKERS`
   - Value: `4` (or any integer from `1` to `20`). Defaults to `2` if not set.

*Tip: You can also override the worker count ad-hoc when manually triggering the workflow via the GitHub Actions UI.*

---

### Step 5: Configure the GitLab Webhook

1. In GitLab, go to your project > **Settings** > **Webhooks**.
2. Click **Add new webhook**:
   - **URL**: `https://<YOUR_CLOUDFLARE_WORKER_URL>/dispatch/<GITHUB_RUNNER_REPO_NAME>`  
     *(Example: `https://gitlab-gha-bridge.my-team.workers.dev/dispatch/my-project-runner`)*
   - **Secret token**: Paste the `GITLAB_SECRET_TOKEN` (if configured in Step 1).
   - **Trigger**: Check **Pipeline events**.
   - **SSL verification**: Ensure *Enable SSL verification* is checked.
3. Click **Add webhook**.
4. Test the connection: Click **Test** > **Pipeline events** next to the created webhook. It should return HTTP `200 OK`.

---

## 📝 Example Pipeline Definition

For reference on structuring multi-stage, containerized builds with services and Docker-in-Docker, see [`.gitlab-ci.example.yml`](.gitlab-ci.example.yml).

---

## 🔍 Technical Details

- **Reusable Workflow**: Core execution logic lives in [`.github/workflows/reusable-runner.yml`](.github/workflows/reusable-runner.yml). All project runner repositories reference this single file, ensuring zero workflow drift across projects.
- **Dynamic Matrix Generation**: The `setup` job parses `WORKERS` and creates a JSON matrix `[1, 2, ..., N]`. GitHub Actions provisions $N$ independent VMs concurrently.
- **Lifecycle & Auto-Shutdown**: Each VM runs `gitlab-runner run-single` inside a loop. When all jobs in the pipeline finish and the queue is empty for 35s, the process exits non-zero, terminating the loop and cleanly stopping the VM.
- **Webhook Bridge**: The worker in [`cloudflare-worker/worker.js`](cloudflare-worker/worker.js) inspects incoming webhook events, validates the pipeline status (`pending` / `created`), extracts the target repo from the URL path, and calls GitHub's `POST /repos/{owner}/{repo}/dispatches` endpoint.

---

## 🛠️ Troubleshooting & FAQ

### Webhook returns HTTP 400 "Missing target repository"
Ensure your GitLab webhook URL includes the target repo path: `https://<WORKER_URL>/dispatch/<REPO_NAME>`.

### Webhook returns HTTP 502 "GitHub API error"
Verify that `GH_PAT` in Cloudflare has valid permissions (`Actions: Read and Write`, `Metadata: Read`) and that `GH_OWNER` in `wrangler.toml` matches the repository owner.

### GitLab CI jobs remain in "Pending" / "Stuck"
- Verify that the runner tag in `.gitlab-ci.yml` matches the tag assigned to the runner in GitLab (or that the runner has "Run untagged jobs" enabled).
- Check that `GITLAB_RUNNER_TOKEN` is correctly set in GitHub Secrets.

### Parallel jobs running sequentially instead of concurrently
Increase the `WORKERS` variable in your GitHub runner repository settings (e.g. `WORKERS = 4`). Ensure your GitHub account has enough available Action concurrency slots.
