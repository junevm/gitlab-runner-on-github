/**
 * Parametric GitLab Webhook -> GitHub Actions Dispatch Bridge (Cloudflare Worker)
 *
 * Routes GitLab Pipeline webhooks to dedicated, isolated GitHub Action runner repos.
 *
 * Routing Options:
 *   1. Path-based:   POST https://bridge.your-subdomain.workers.dev/dispatch/my-project-runner
 *   2. Query-based:  POST https://bridge.your-subdomain.workers.dev/dispatch?repo=my-project-runner
 *   3. Default:      Falls back to env.GH_DEFAULT_REPO if configured.
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed. Only POST is supported." }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
    }

    // Optional Shared Secret Validation
    if (env.GITLAB_SECRET_TOKEN) {
      const token = request.headers.get("X-Gitlab-Token");
      if (token !== env.GITLAB_SECRET_TOKEN) {
        return new Response(
          JSON.stringify({ error: "Unauthorized: Invalid X-Gitlab-Token header" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const eventType = request.headers.get("X-Gitlab-Event");
    const objectKind = payload.object_kind;
    const pipelineStatus = payload.object_attributes?.status;

    // Only trigger when a pipeline is created or pending
    const isPipelineEvent = objectKind === "pipeline" || eventType === "Pipeline Hook";
    const isActionableStatus = ["pending", "created", "running"].includes(pipelineStatus);

    if (!isPipelineEvent || !isActionableStatus) {
      return new Response(
        JSON.stringify({
          message: "Ignored event",
          object_kind: objectKind,
          status: pipelineStatus,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Resolve Target GitHub Repository
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    
    // Check path: /dispatch/:repo or /:repo
    let targetRepo = null;
    if (pathSegments.length >= 2 && pathSegments[0] === "dispatch") {
      targetRepo = pathSegments[1];
    } else if (pathSegments.length === 1 && pathSegments[0] !== "dispatch") {
      targetRepo = pathSegments[0];
    }

    // Check query parameter fallback: ?repo=...
    if (!targetRepo) {
      targetRepo = url.searchParams.get("repo");
    }

    // Fallback to default repo
    if (!targetRepo) {
      targetRepo = env.GH_DEFAULT_REPO;
    }

    if (!targetRepo) {
      return new Response(
        JSON.stringify({
          error: "Missing target repository. Provide it via path (/dispatch/my-repo) or ?repo=my-repo",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const githubOwner = env.GH_OWNER;
    const githubToken = env.GH_PAT;

    if (!githubOwner || !githubToken) {
      return new Response(
        JSON.stringify({ error: "Worker missing GH_OWNER or GH_PAT environment variables." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Dispatch to GitHub Actions
    const ghApiUrl = `https://api.github.com/repos/${githubOwner}/${targetRepo}/dispatches`;
    const ghResponse = await fetch(ghApiUrl, {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${githubToken}`,
        "User-Agent": "GitLab-GHA-Bridge",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "gitlab_pipeline",
        client_payload: {
          pipeline_id: payload.object_attributes?.id,
          ref: payload.object_attributes?.ref,
          project_id: payload.project?.id,
          project_name: payload.project?.name,
          user: payload.user?.username,
        },
      }),
    });

    if (!ghResponse.ok) {
      const errorText = await ghResponse.text();
      return new Response(
        JSON.stringify({
          error: `GitHub API error (${ghResponse.status})`,
          target_repo: `${githubOwner}/${targetRepo}`,
          details: errorText,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        message: "Successfully triggered GitHub Actions runner!",
        target_repo: `${githubOwner}/${targetRepo}`,
        pipeline_id: payload.object_attributes?.id,
        ref: payload.object_attributes?.ref,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  },
};
