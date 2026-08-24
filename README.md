# Ephemeral GitLab Docker Runner on GitHub Actions

Run GitLab CI/CD pipelines on-demand inside isolated Docker containers on GitHub Actions VMs with zero idle cost.


## 📐 Architecture & How It Works

```text
┌───────────────────────────┐
│ GitLab Project            │
│  Pipeline created         │
└─────────────┬─────────────┘
              │ 1. Webhook (Pipeline event + HMAC Signature)
              ▼
┌───────────────────────────┐
│ Cloudflare Worker         │
│  - Verifies HMAC signature│
│  - Uses GH_PAT to dispatch│
└─────────────┬─────────────┘
              │ 2. POST /repos/{owner}/{repo}/dispatches (using GH_PAT)
              ▼
┌───────────────────────────┐
│ GitHub Actions Runner Repo│
│  - Spawns N parallel VMs  │
│  - Runs gitlab-runner     │
│    container with glrt-.. │
└─────────────┬─────────────┘
              │ 3. Pulls jobs & streams logs via Docker executor
              ▼
┌───────────────────────────┐
│ GitLab Job Execution      │
│  - Containers run on GHA  │
│  - Auto-shuts down on idle│
└───────────────────────────┘
```


## 🔐 Secrets & Tokens Reference

| Token / Secret | Where It Is Stored | Purpose & How It Is Used | Required |
| :--- | :--- | :--- | :--- |
| **`GH_PAT`** | **Cloudflare Worker Secret** (`mise run worker:secret:pat`) | **GitHub Personal Access Token**. The Cloudflare Worker uses this token in the `Authorization: Bearer <GH_PAT>` header to call GitHub's API (`POST /repos/{owner}/{repo}/dispatches`) to trigger your GitHub Actions runner workflows. | **Yes** |
| **`GH_OWNER`** | **`cloudflare-worker/wrangler.toml`** (`[vars] GH_OWNER = "..."`) | Your GitHub username or organization (e.g. `junevm`). The Worker uses this to construct GitHub API URLs. | **Yes** |
| **`GITLAB_SIGNING_TOKEN`** | **Cloudflare Worker Secret** (`mise run worker:secret:signing-token`) | **Webhook HMAC-SHA256 Signing Key** (`whsec_...`). Generated in GitLab Webhook settings. The Cloudflare Worker uses this key to cryptographically verify that incoming webhooks genuinely originated from your GitLab instance. | **Recommended** |
| **`GITLAB_RUNNER_TOKEN`** | **GitHub Repository Secret** (GitHub Repo > Settings > Secrets > Actions) | **GitLab Runner Authentication Token** (`glrt-...`). Created in GitLab CI/CD > Runners. The `gitlab-runner` container uses this token to register and fetch pending pipeline jobs from GitLab. | **Yes** |
| **`WORKERS`** | **GitHub Repository Variable** (GitHub Repo > Settings > Variables > Actions) | *(Optional)* Number of parallel GitHub Actions VMs to spawn per pipeline. Defaults to `2`. | Optional |
| **`GITLAB_URL`** | **GitHub Repository Secret** | *(Optional)* Target GitLab instance URL (e.g. `https://gitlab.example.com`). Defaults to `https://gitlab.com` if omitted. | Optional |


## 🚀 Step-by-Step Setup Guide

### 1. Deploy the Cloudflare Webhook Bridge (One-Time Setup)

The Cloudflare Worker is a single, central router that receives webhooks from any number of GitLab projects and triggers their corresponding GitHub runner repositories.

1. **Create the GitHub Personal Access Token (`GH_PAT`)**:
   - Go to GitHub > **Settings** > **Developer Settings** > **Personal access tokens** > **Fine-grained tokens**.
   - Click **Generate new token**.
   - **Repository access**: Select *All repositories* (or select your runner repositories).
   - **Repository permissions**:
     - **Actions**: `Read and write` (Required to trigger `repository_dispatch` events).
     - **Metadata**: `Read-only`.
   - Click **Generate token** and copy the value (`github_pat_...`).

2. **Configure & Deploy the Worker**:
   - Open [`cloudflare-worker/wrangler.toml`](cloudflare-worker/wrangler.toml) and set `GH_OWNER` to your GitHub username or organization:
     ```toml
     [vars]
     GH_OWNER = "your-github-username-or-org"
     ```
   - Authenticate with Cloudflare, save `GH_PAT`, and deploy:
     ```bash
     cd cloudflare-worker && npx wrangler login
     mise run worker:secret:pat        # Paste your github_pat_... token when prompted
     mise run worker:deploy
     ```
   - Note the published worker URL (e.g. `https://gitlab-gha-bridge.<subdomain>.workers.dev`).


### 2. Register a Runner in GitLab

1. In your GitLab project: go to **Settings** > **CI/CD** > expand **Runners**.
2. Click **New project runner**.
3. Under **Platform**, choose **Linux**.
4. Under **Tags**, add a tag (e.g. `docker-runner`) or check **Run untagged jobs**.
5. Click **Create runner**.
6. Copy the generated **Runner authentication token** (starts with `glrt-...`).


### 3. Create the GitHub Runner Repository

1. On GitHub, create a repository for this project's runner (e.g. `my-project-runner`).
2. Add [`.github/workflows/runner.yml`](.github/workflows/runner.yml) to the repository.
3. Configure repository settings (**Settings** > **Secrets and variables** > **Actions**):
   - **Secrets tab** > **New repository secret**:
     - Name: `GITLAB_RUNNER_TOKEN`
     - Value: Paste the `glrt-...` token from Step 2.
   - **Variables tab** > **New repository variable** *(optional)*:
     - Name: `WORKERS`
     - Value: `4` (number of parallel VMs to spawn, default is `2`).


### 4. Configure the GitLab Webhook

1. In your GitLab project: go to **Settings** > **Webhooks** > **Add new webhook**.
2. **URL**: `https://<YOUR_CLOUDFLARE_WORKER_URL>/dispatch/<GITHUB_RUNNER_REPO_NAME>`  
   *(Example: `https://gitlab-gha-bridge.my-subdomain.workers.dev/dispatch/my-project-runner`)*
3. **Authentication**:
   - Under **Signing token**, click **Generate signing token** and copy the `whsec_...` key.
   - Save the key into your Cloudflare Worker:
     ```bash
     mise run worker:secret:signing-token   # Paste whsec_... key when prompted
     mise run worker:deploy
     ```
4. **Trigger**: Check **Pipeline events**.
5. Click **Add webhook**.


### 5. Verify the Entire Setup

1. In GitLab **Settings** > **Webhooks**, find your webhook and click **Test** > **Pipeline events**.
2. You should see a success banner: `Hook executed successfully: HTTP 200` (or `HTTP 201`).
3. Check your GitHub runner repository under the **Actions** tab:
   - A workflow run `gitlab_pipeline` will appear immediately.
   - It spawns $N$ parallel Ubuntu VMs (`WORKERS`).
   - Each VM runs `gitlab/gitlab-runner:latest` in Docker, claims pending GitLab jobs, and executes them.
   - When no jobs remain for 35 seconds, the runner exits and the GitHub VMs terminate cleanly.


## 🛠️ Local Tasks (`mise`)

```bash
mise run lint                        # Lint GitHub Actions workflow definitions
mise run worker:dev                  # Start local Cloudflare Worker dev server
mise run worker:deploy               # Deploy Cloudflare Worker to production
mise run worker:secret:pat           # Save GH_PAT secret to Cloudflare Worker
mise run worker:secret:signing-token # Save GitLab HMAC signing token to Cloudflare Worker
mise run worker:secret:token         # Save legacy GitLab secret token to Cloudflare Worker
```


## 🛠️ Troubleshooting & FAQ

| Error / Issue | Root Cause | Solution |
| :--- | :--- | :--- |
| **HTTP 500: Missing GH_OWNER or GH_PAT** | `GH_PAT` secret is not configured in Cloudflare Worker. | Run `mise run worker:secret:pat`, paste your GitHub token (`github_pat_...`), then run `mise run worker:deploy`. |
| **HTTP 401: Invalid webhook-signature HMAC** | The `whsec_...` key in GitLab does not match `GITLAB_SIGNING_TOKEN` in Cloudflare. | Run `mise run worker:secret:signing-token`, paste the key from GitLab, then run `mise run worker:deploy`. |
| **HTTP 400: Missing target repository** | Webhook URL path does not contain the GitHub repo name. | Ensure webhook URL is `https://<WORKER_URL>/dispatch/<GITHUB_RUNNER_REPO>`. |
| **GitLab jobs stuck in "Pending"** | Runner tag mismatch or missing `GITLAB_RUNNER_TOKEN`. | In GitLab runner settings, enable **Run untagged jobs**, and verify `GITLAB_RUNNER_TOKEN` is set in GitHub repository secrets. |
| **GitHub Actions run fails immediately** | Invalid workflow syntax or permissions. | Verify `runner.yml` is on the default branch and that `GH_PAT` has `Actions: Read and write` permission. |
