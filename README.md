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
                               │ [HMAC-SHA256 / X-Gitlab-Token]
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Cloudflare Worker (Parametric Webhook Router)               │
│                                                             │
│  POST https://bridge.workers.dev/dispatch/backend-runner    │
│  Validates signature ──► POST /repos/org/backend-runner/... │
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
6. **GitLab Webhook Standard Compliance**: Supports both modern GitLab **HMAC-SHA256 Signing Tokens** (`webhook-signature` header) and legacy **Secret Tokens** (`X-Gitlab-Token` header).

---

## 🛠️ Local Development & Tooling with `mise`

This repository is preconfigured with [`mise.toml`](mise.toml) and [`mise.lock`](mise.lock) (with `lockfile = true` enabled) for pinned, reproducible toolchains (`node@lts`, `actionlint@latest`, `shellcheck@latest`) across all platforms:

```bash
# Install all pinned dev tools
mise install

# Available project tasks
mise run lint                     # Lint GitHub Actions workflows (actionlint + shellcheck)
mise run worker:dev               # Start local Cloudflare Worker development server
mise run worker:deploy            # Deploy the Cloudflare Worker bridge
mise run worker:secret:pat        # Set GH_PAT secret in Cloudflare Worker
mise run worker:secret:signing-token # Set GitLab HMAC-SHA256 Signing Token (Recommended)
mise run worker:secret:token      # Set legacy GitLab Secret Token
```

---

## 📋 Prerequisites

- **GitLab**: Maintainer or Owner role in your GitLab project (or group).
- **GitHub**: Account or Organization with repository creation permissions.
- **Cloudflare**: Free account (used for the zero-cost webhook bridge).
- **Local Tools**: [`mise`](https://mise.jdx.dev) (recommended) or `node` (v18+) and `npm`.

---

## 🚀 Step-by-Step Setup Guide

### Step 1: Deploy the Cloudflare Webhook Router (One-time Setup)

The Cloudflare Worker bridges GitLab Webhook payloads to GitHub's `repository_dispatch` API.

1. **Generate a GitHub Personal Access Token (PAT)**:
   - Go to GitHub > **Settings** > **Developer Settings** > **Personal access tokens** > **Fine-grained tokens** (or Classic).
   - **Repository access**: Select *All repositories* or *Only select repositories* (your runner repos).
   - **Permissions**: `Actions` (Read and Write), `Metadata` (Read).
   - Copy the generated token (`github_pat_...`).

2. **Configure the Worker**:
   - Open [`cloudflare-worker/wrangler.toml`](cloudflare-worker/wrangler.toml).
   - Update `GH_OWNER` with your GitHub username or organization name.

3. **Deploy the Worker and Store GitHub PAT**:
   - Authenticate with Cloudflare:
     ```bash
     cd cloudflare-worker && npx wrangler login
     ```
   - Store your GitHub PAT secret:
     ```bash
     mise run worker:secret:pat
     # (Runs: npx wrangler secret put GH_PAT)
     ```
   - Deploy the worker:
     ```bash
     mise run worker:deploy
     # (Runs: npx wrangler deploy)
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
   *(Note: This token is displayed only once).*

---

### Step 3: Create the Dedicated GitHub Runner Repository

1. On GitHub, create a new private repository for this project's runner (e.g., `my-project-runner`).
2. Add the caller workflow file to the repo at [`.github/workflows/runner.yml`](.github/workflows/runner.yml):
   - Copy the contents from this repository's [`.github/workflows/runner.yml`](.github/workflows/runner.yml).
   - Update the `uses:` reference to point to this central repository:
     ```yaml
     uses: <YOUR_GITHUB_ORG_OR_USER>/gitlab-runner-on-github/.github/workflows/reusable-runner.yml@main
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

GitLab supports two authentication mechanisms for webhooks. For best security, use a **Signing Token** (HMAC-SHA256 signature verification):

1. In GitLab, navigate to your project > **Settings** > **Webhooks**.
2. Click **Add new webhook**:
   - **URL**: `https://<YOUR_CLOUDFLARE_WORKER_URL>/dispatch/<GITHUB_RUNNER_REPO_NAME>`  
     *(Example: `https://gitlab-gha-bridge.my-team.workers.dev/dispatch/my-project-runner`)*
   - **Authentication** (Choose one):
     - **Option A: Signing Token (Recommended)**:
       - Under **Signing token**, click **Generate signing token**.
       - Copy the generated token (starts with `whsec_...`).
       - Save it into your Cloudflare Worker:
         ```bash
         mise run worker:secret:signing-token
         # (Runs: npx wrangler secret put GITLAB_SIGNING_TOKEN)
         ```
     - **Option B: Secret Token (Legacy)**:
       - Enter a secret string in **Secret token** (e.g. `openssl rand -hex 24`).
       - Save it into your Cloudflare Worker:
         ```bash
         mise run worker:secret:token
         # (Runs: npx wrangler secret put GITLAB_SECRET_TOKEN)
         ```
   - **Deploy the Worker** (Required whenever you add or update secrets):
     ```bash
     mise run worker:deploy
     ```
   - **Trigger**: Check **Pipeline events** (triggers whenever a pipeline is created, pending, or status changes).
   - **Enable SSL verification**: Keep checked.
3. Click **Add webhook**.

---

### Step 6: Test & Verify Webhook Connection

1. In GitLab, under **Project Settings** > **Webhooks**, locate your webhook in the list.
2. Click **Test** > select **Pipeline events**.
3. You should see a success banner: `Hook executed successfully: HTTP 200`.
4. **Inspect Delivery Details**:
   - Scroll down to the **Recent events** section.
   - Click **View details** next to any delivery to inspect the exact HTTP headers (`X-Gitlab-Event`, `webhook-signature`), request body, response code (`200 OK`), and response JSON.
   - If needed, click **Resend request** to replay test payloads without triggering a new commit.

---

### Step 7: Run Your First CI/CD Pipeline

With setup complete, verify the full automated flow:

1. In your GitLab project repository, create or update `.gitlab-ci.yml` (see [`.gitlab-ci.example.yml`](.gitlab-ci.example.yml) for sample jobs).
2. Commit and push your code to GitLab:
   ```bash
   git add .gitlab-ci.yml
   git commit -m "Configure CI pipeline"
   git push origin main
   ```
3. **Observe Automated Execution**:
   - **GitLab**: The pipeline is created and enters `pending` status. Webhook triggers automatically.
   - **Cloudflare Worker**: Authenticates the payload and dispatches a workflow run to GitHub Actions.
   - **GitHub Actions**: Spawns $N$ parallel Ubuntu VMs (`vars.WORKERS`), pulls the `gitlab-runner` binary, and registers with Docker executor.
   - **Live Execution**: GitLab CI jobs execute inside Docker containers on the GitHub VMs. Logs stream live in the GitLab UI.
   - **Clean Auto-Shutdown**: When all pipeline stages complete, the runners wait 35s, find no remaining jobs, and exit. The GitHub VMs shut down with zero wasted minutes.

---

## 📝 Example Pipeline Definition

For reference on structuring multi-stage, containerized builds with services and Docker-in-Docker, see [`.gitlab-ci.example.yml`](.gitlab-ci.example.yml).

---

## 🔄 Day-2 Operations & Scaling

- **Adding More Projects**: To onboard another GitLab project, repeat **Steps 2 to 5**. You reuse the exact same Cloudflare Worker endpoint and central workflow without writing new code.
- **Updating Runner Versions / Logic**: Changes made to [`.github/workflows/reusable-runner.yml`](.github/workflows/reusable-runner.yml) in this repository automatically propagate to all project runner repos on their next pipeline run.
- **Adjusting Concurrency**: Change `WORKERS` under GitHub Repo Settings > Variables at any time to scale parallel worker VMs up or down.

---

## 🔍 Technical Details

- **Reusable Workflow**: Core execution logic lives in [`.github/workflows/reusable-runner.yml`](.github/workflows/reusable-runner.yml). All project runner repositories reference this single file, ensuring zero workflow drift across projects.
- **Dynamic Matrix Generation**: The `setup` job parses `WORKERS` and creates a JSON matrix `[1, 2, ..., N]`. GitHub Actions provisions $N$ independent VMs concurrently.
- **Lifecycle & Auto-Shutdown**: Each VM runs `gitlab-runner run-single` inside a loop. When all jobs in the pipeline finish and the queue is empty for 35s, the process exits non-zero, terminating the loop and cleanly stopping the VM.
- **Webhook Bridge**: The worker in [`cloudflare-worker/worker.js`](cloudflare-worker/worker.js) validates the cryptographic signature (`webhook-signature`) or `X-Gitlab-Token` header, confirms the pipeline status (`pending` / `created`), extracts the target repo from the URL path, and calls GitHub's `POST /repos/{owner}/{repo}/dispatches` endpoint.

---

## 🛠️ Troubleshooting & FAQ

### Webhook returns HTTP 401 "Unauthorized: Invalid webhook-signature HMAC"
The signing token configured in GitLab does not match `GITLAB_SIGNING_TOKEN` in Cloudflare. Run `mise run worker:secret:signing-token` to update it with the `whsec_...` value from GitLab, then run `mise run worker:deploy`.

### Webhook returns HTTP 401 "Unauthorized: Invalid X-Gitlab-Token header"
The secret string entered in GitLab Webhook settings does not match `GITLAB_SECRET_TOKEN` in Cloudflare. Update either GitLab's Webhook Secret Token or run `mise run worker:secret:token` to realign them, then run `mise run worker:deploy`.

### Webhook returns HTTP 400 "Missing target repository"
Ensure your GitLab webhook URL includes the target repo path: `https://<WORKER_URL>/dispatch/<REPO_NAME>`.

### Webhook returns HTTP 502 "GitHub API error"
Verify that `GH_PAT` in Cloudflare has valid permissions (`Actions: Read and Write`, `Metadata: Read`) and that `GH_OWNER` in `wrangler.toml` matches the repository owner.

### GitLab Webhook has "Disabled" badge
GitLab automatically disables webhooks if they repeatedly encounter 5xx errors or exceed the 10-second timeout. Once the endpoint is healthy, click **Edit** on the webhook in GitLab, clear the disabled status, and click **Save changes**.

### GitLab CI jobs remain in "Pending" / "Stuck"
- Verify that the runner tag in `.gitlab-ci.yml` matches the tag assigned to the runner in GitLab (or that the runner has "Run untagged jobs" enabled).
- Check that `GITLAB_RUNNER_TOKEN` is correctly set in GitHub Secrets.

### Parallel jobs running sequentially instead of concurrently
Increase the `WORKERS` variable in your GitHub runner repository settings (e.g. `WORKERS = 4`). Ensure your GitHub account has enough available Action concurrency slots.

---

## 🏁 Summary

This setup delivers a production-ready CI/CD bridge with:
- **Zero Idle Infrastructure**: VMs exist only while jobs are running and shut down 35 seconds after pipeline completion.
- **Complete Project Isolation**: 1:1 dedicated runner repositories and project-level authentication tokens guarantee zero cross-project contamination.
- **Enterprise-Grade Security**: Cryptographic HMAC-SHA256 webhook signatures and ephemeral, single-use GitHub Action environments.
- **Effortless Scaling**: A single Cloudflare Worker and central reusable workflow power unlimited GitLab projects across your organization.
