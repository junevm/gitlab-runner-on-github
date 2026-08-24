# Ephemeral GitLab Docker Runner on GitHub Actions

Run GitLab CI/CD pipelines on-demand inside isolated Docker containers on GitHub Actions VMs with zero idle cost.

---

## 📐 Architecture

```text
GitLab Pipeline (Pending)
   │ (Webhook)
   ▼
Cloudflare Worker (Router) ──[GH_PAT]──► GitHub Actions Repo (N VMs)
                                              │
                                              ▼
                                         docker run gitlab/gitlab-runner
                                         (Pulls & executes jobs, auto-exits)
```

---

## 📋 Prerequisites & Secrets

### Tooling
- Local tools: [`mise`](https://mise.jdx.dev) (or `node` v18+ and `npm`).

### Secrets & Variables Reference

| Name | Storage Location | Description | Required |
| :--- | :--- | :--- | :--- |
| **`GH_OWNER`** | `cloudflare-worker/wrangler.toml` | Target GitHub username or organization (e.g. `junevm`). | Yes |
| **`GH_PAT`** | Cloudflare Worker Secret | GitHub Personal Access Token with `Actions: Read & write` and `Metadata: Read`. | Yes |
| **`GITLAB_SIGNING_TOKEN`** | Cloudflare Worker Secret | Webhook HMAC-SHA256 signing secret (`whsec_...`) from GitLab. | Recommended |
| **`GITLAB_RUNNER_TOKEN`** | GitHub Repository Secret | Project runner authentication token (`glrt-...`) from GitLab CI/CD Settings. | Yes |
| **`WORKERS`** | GitHub Repository Variable | *(Optional)* Number of parallel VM workers to spawn (e.g. `2`, `4`). Defaults to `2`. | Optional |
| **`GITLAB_URL`** | GitHub Repository Secret | *(Optional)* Target GitLab instance URL. Defaults to `https://gitlab.com`. | Optional |

---

## 🚀 Setup Guide

### 1. Deploy the Webhook Bridge (One-Time)

The Cloudflare Worker verifies incoming GitLab webhooks and triggers GitHub Actions workflow runs via `repository_dispatch`.

1. **Generate a GitHub Personal Access Token (PAT)**:
   - In GitHub: **Settings** > **Developer Settings** > **Personal access tokens** > **Fine-grained tokens**.
   - Set Repository Access to your runner repositories.
   - Set Permissions: **Actions** (`Read and write`), **Metadata** (`Read-only`).
   - Copy the generated token (`github_pat_...`).

2. **Configure & Deploy**:
   - Update `GH_OWNER` in [`cloudflare-worker/wrangler.toml`](cloudflare-worker/wrangler.toml) with your GitHub username or org.
   - Save your PAT and deploy:
     ```bash
     cd cloudflare-worker && npx wrangler login
     mise run worker:secret:pat        # Paste github_pat_... when prompted
     mise run worker:deploy
     ```
   - Note the deployed URL (e.g. `https://gitlab-gha-bridge.<subdomain>.workers.dev`).

---

### 2. Register Runner in GitLab

1. In GitLab: navigate to your project > **Settings** > **CI/CD** > **Runners**.
2. Click **New project runner**.
3. Select Platform **Linux**, configure tags (or check **Run untagged jobs**), and click **Create runner**.
4. Copy the displayed runner token (`glrt-...`).

---

### 3. Setup GitHub Runner Repository

1. Create a GitHub repository for this runner (e.g. `my-project-runner`).
2. Add [`.github/workflows/runner.yml`](.github/workflows/runner.yml) to the repository.
3. In GitHub: **Settings** > **Secrets and variables** > **Actions**:
   - Under **Secrets**, add `GITLAB_RUNNER_TOKEN` with the `glrt-...` token.
   - *(Optional)* Under **Variables**, add `WORKERS` with the desired concurrency (e.g. `4`).

---

### 4. Configure GitLab Webhook

1. In GitLab: **Settings** > **Webhooks** > **Add new webhook**.
2. **URL**: `https://<YOUR_WORKER_URL>/dispatch/<GITHUB_RUNNER_REPO>`
3. **Authentication**:
   - Under **Signing token**, click **Generate signing token** (`whsec_...`).
   - Save it into Cloudflare:
     ```bash
     mise run worker:secret:signing-token   # Paste whsec_... when prompted
     mise run worker:deploy
     ```
4. **Trigger**: Check **Pipeline events**.
5. Click **Add webhook**, then click **Test** > **Pipeline events** to verify (`HTTP 200` / `201`).

---

## 🛠️ Local Tasks (`mise`)

```bash
mise run lint                        # Lint GitHub Actions workflows
mise run worker:dev                  # Run local Cloudflare Worker development server
mise run worker:deploy               # Deploy Cloudflare Worker to production
mise run worker:secret:pat           # Set GitHub PAT secret in Cloudflare
mise run worker:secret:signing-token # Set GitLab HMAC signing token secret in Cloudflare
mise run worker:secret:token         # Set legacy GitLab secret token in Cloudflare
```

---

## 🔍 Execution Lifecycle

```text
1. Pipeline created in GitLab (pending)
2. Webhook triggers Cloudflare Worker
3. Worker authenticates signature & dispatches event to GitHub Actions
4. GitHub Actions spawns N parallel VMs (WORKERS)
5. Each VM runs: docker run --rm gitlab/gitlab-runner:latest run-single
6. GitLab jobs execute inside Docker containers
7. When queue is empty for 35s, runners exit and VMs terminate cleanly
```

---

## 🛠️ Troubleshooting

| Status / Issue | Cause | Fix |
| :--- | :--- | :--- |
| **HTTP 500: Missing GH_PAT** | `GH_PAT` secret not set in Cloudflare | Run `mise run worker:secret:pat` and `mise run worker:deploy`. |
| **HTTP 401: Invalid signature** | `GITLAB_SIGNING_TOKEN` mismatch | Update token via `mise run worker:secret:signing-token` and redeploy. |
| **HTTP 400: Missing target repo** | Webhook URL path missing repo | Set URL to `https://<WORKER_URL>/dispatch/<REPO_NAME>`. |
| **Jobs remain "Pending"** | Runner tag mismatch | Ensure runner has **Run untagged jobs** enabled or tags match `.gitlab-ci.yml`. |
