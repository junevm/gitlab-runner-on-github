Ahh, **now I get your idea**.

You want to use a **GitHub Actions-hosted VM as an ephemeral GitLab self-hosted runner**:

```text
GitLab pipeline starts
      ↓
GitHub Actions starts
      ↓
GitHub Ubuntu VM
      ↓
install GitLab Runner
      ↓
register to GitLab
      ↓
GitLab assigns jobs to it
      ↓
GitLab Runner executes them
```

**Yes, technically this can work**, but there's a bootstrapping problem: GitLab cannot magically start the GitHub Actions VM by itself. You need a **small trigger/control plane**.

## The clever architecture

Use a GitHub Actions workflow as an **ephemeral GitLab Runner provisioner**:

```text
GitLab
  │
  │ API/webhook trigger
  ▼
GitHub Actions
  │
  ▼
ubuntu-latest VM
  │
  ├─ download gitlab-runner
  ├─ register with GitLab
  ├─ run gitlab-runner
  │
  ▼
GitLab CI jobs execute here
```

GitLab Runner supports being registered dynamically with a runner authentication token and run directly with `gitlab-runner run`. ([GitLab Docs][1])

### GitHub workflow

```yaml
name: GitLab Runner

on:
  workflow_dispatch:

jobs:
  runner:
    runs-on: ubuntu-latest

    steps:
      - name: Install GitLab Runner
        run: |
          curl -L \
            https://gitlab-runner-downloads.s3.amazonaws.com/latest/binaries/gitlab-runner-linux-amd64 \
            -o gitlab-runner

          chmod +x gitlab-runner

      - name: Register GitLab Runner
        env:
          GITLAB_RUNNER_TOKEN: ${{ secrets.GITLAB_RUNNER_TOKEN }}
        run: |
          ./gitlab-runner register \
            --non-interactive \
            --url "https://gitlab.com" \
            --token "$GITLAB_RUNNER_TOKEN" \
            --executor "shell"

      - name: Run GitLab Runner
        run: ./gitlab-runner run
```

The `run` command keeps the GitHub Actions job alive while the GitLab Runner polls GitLab and executes jobs.

Your GitLab jobs would then use:

```yaml
build:
  tags:
    - github-runner
  script:
    - echo "running on GitHub-hosted VM"
    - make build
```

## But: the real problem is triggering it automatically

GitLab pipeline:

```text
pipeline created
    │
    ▼
needs runner ❌
```

The GitHub VM must already exist.

### Best solution: keep a provisioning workflow running

GitHub Actions:

```text
workflow starts
    │
    ▼
GitLab runner connects
    │
    ▼
waits for GitLab job
    │
    ▼
executes job
```

But GitHub-hosted runners have a maximum job lifetime, so you cannot keep one permanently running. After the job completes, the VM disappears.

## The approach I'd actually recommend

Create a **GitHub Actions workflow that provisions one temporary GitLab runner**, then trigger that workflow from GitLab.

```text
GitLab pipeline
     │
     ├── trigger GitHub API
     │
     ▼
GitHub Actions VM starts
     │
     ▼
registers as GitLab Runner
     │
     ▼
GitLab jobs wait
     │
     ▼
runner picks up job
     │
     ▼
job finishes
     │
     ▼
GitHub VM dies
```

The initial GitLab job that triggers GitHub would need to run somewhere, though. That's the catch: it would consume at least a little GitLab runner time unless triggered externally.

### Better: use a GitLab webhook

```text
push to GitLab
    │
    ▼
GitLab webhook
    │
    ▼
GitHub repository_dispatch
    │
    ▼
GitHub Actions
    │
    ▼
GitLab Runner starts
```

Then **zero GitLab compute is needed to provision the runner**.

## Important limitation

This is not truly "free unlimited GitLab CI." GitHub-hosted runners have their own quotas and billing rules, and using them as an arbitrary long-running GitLab runner is an unusual use case. GitHub-hosted runners are designed for Actions jobs, while GitLab Runner is designed to execute GitLab jobs. ([GitHub][2])

Also, a `shell` executor would execute GitLab job commands directly on the GitHub VM. GitLab officially supports registering and running a shell executor this way. ([GitLab Docs][3])

## The architecture I would build for you

```text
                 ┌──────────────────────┐
                 │       GitLab         │
                 │                      │
git push ───────► │ pipeline created    │
                 │ jobs queued          │
                 └──────────┬───────────┘
                            │ webhook
                            ▼
                 ┌──────────────────────┐
                 │ GitHub Actions       │
                 │ ubuntu-latest        │
                 │                      │
                 │ install runner       │
                 │ register runner      │
                 │                      │
                 │  ┌──────────────┐    │
                 │  │GitLab Runner │◄───┼──── polls GitLab
                 │  └──────┬───────┘    │
                 │         ▼            │
                 │    executes CI       │
                 └──────────────────────┘
```

**Yes, this is exactly the hack you're thinking of, and it should be possible.** The main engineering challenge is making the GitHub Actions workflow start automatically and registering a fresh ephemeral GitLab runner safely for each pipeline. The runner authentication-token registration flow is the modern GitLab approach. ([GitLab Docs][1])

If you want, I can give you the **actual fire-and-forget implementation**: GitLab webhook → GitHub Actions → ephemeral GitLab runner → automatic cleanup, with the exact YAML and API setup.

[1]: https://docs.gitlab.com/runner/register/?utm_source=chatgpt.com "Registering runners | GitLab Docs"
[2]: https://github.com/actions/runner/blob/main/docs/design/auth.md?utm_source=chatgpt.com "runner/docs/design/auth.md at main · actions/runner · GitHub"
[3]: https://docs.gitlab.com/tutorials/create_register_first_runner/?utm_source=chatgpt.com "Tutorial: Create, register, and run your own project runner | GitLab Docs"
