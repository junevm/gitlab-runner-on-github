/**
 * Parametric GitLab Webhook -> GitHub Actions Dispatch Bridge (Cloudflare Worker)
 *
 * Routes GitLab Pipeline and Job webhooks to dedicated GitHub Action runner repos.
 * Implements JIT Auto-Scaling:
 *   - Pipeline Events: counts currently 'pending' jobs in the active stage.
 *   - Job Events: bursts a runner whenever any job transitions to 'pending'.
 */

async function verifyHmacSignature(signingToken, messageId, timestamp, rawBody, receivedSignatures) {
  if (!signingToken || !messageId || !timestamp || !receivedSignatures) return false;
  try {
    const rawKeyBase64 = signingToken.replace(/^whsec_/, "");
    const binaryKey = Uint8Array.from(atob(rawKeyBase64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "raw",
      binaryKey,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const message = `${messageId}.${timestamp}.${rawBody}`;
    const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    const expectedSig = "v1," + btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

    // Split space-separated signatures and compare
    const sigList = receivedSignatures.split(" ");
    return sigList.includes(expectedSig);
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed. Only POST is supported." }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
    }

    const rawBody = await request.text();

    // Check headers provided by GitLab
    const headerToken = request.headers.get("X-Gitlab-Token");
    const signature = request.headers.get("webhook-signature");
    const messageId = request.headers.get("webhook-id");
    const timestamp = request.headers.get("webhook-timestamp");

    // Resolve configured signing token and secret token (with auto-detection)
    let configuredSigningToken = env.GITLAB_SIGNING_TOKEN;
    let configuredSecretToken = env.GITLAB_SECRET_TOKEN;

    if (configuredSecretToken && configuredSecretToken.startsWith("whsec_") && !configuredSigningToken) {
      configuredSigningToken = configuredSecretToken;
      configuredSecretToken = undefined;
    }

    // Authentication Validation
    const requiresAuth = Boolean(configuredSigningToken || configuredSecretToken);

    if (requiresAuth) {
      let authenticated = false;

      // 1. Check Signing Token (HMAC-SHA256)
      if (configuredSigningToken && signature) {
        authenticated = await verifyHmacSignature(
          configuredSigningToken,
          messageId,
          timestamp,
          rawBody,
          signature
        );
      }

      // 2. Check Plain Secret Token (X-Gitlab-Token)
      if (!authenticated && configuredSecretToken && headerToken) {
        authenticated = (headerToken === configuredSecretToken);
      }

      if (!authenticated) {
        let failureReason = "Token mismatch or missing authentication header.";
        if (configuredSigningToken && !signature) {
          failureReason = "Worker expects a GitLab Signing Token (webhook-signature header), but GitLab sent a plain token or none. Generate a signing token in GitLab or configure GITLAB_SECRET_TOKEN in Cloudflare.";
        } else if (configuredSecretToken && !headerToken) {
          failureReason = "Worker expects X-Gitlab-Token header, but none was sent by GitLab. Ensure 'Secret token' is filled in GitLab Webhook settings.";
        }

        return new Response(
          JSON.stringify({
            error: "Unauthorized: Invalid webhook authentication",
            details: failureReason,
            received_headers: {
              has_x_gitlab_token: Boolean(headerToken),
              has_webhook_signature: Boolean(signature)
            }
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const eventType = request.headers.get("X-Gitlab-Event");
    const objectKind = payload.object_kind;

    let isActionable = false;
    let requiredWorkers = 1;
    let activeStage = "default";
    let pipelineId = payload.object_attributes?.id || payload.pipeline_id;
    let refName = payload.object_attributes?.ref || payload.ref;

    if (objectKind === "pipeline" || eventType === "Pipeline Hook") {
      const pipelineStatus = payload.object_attributes?.status;
      if (["pending", "created", "running"].includes(pipelineStatus)) {
        // Filter strictly for jobs that are currently pending execution (not created/waiting)
        const builds = payload.builds || [];
        const pendingBuilds = builds.filter((b) => b.status === "pending");

        // If builds array exists, only dispatch if there is at least 1 pending job
        if (builds.length === 0 || pendingBuilds.length > 0) {
          isActionable = true;
          requiredWorkers = Math.max(1, pendingBuilds.length || 1);
          activeStage = pendingBuilds[0]?.stage || "default";
        }
      }
    } else if (objectKind === "build" || eventType === "Job Hook") {
      // Job event: fires whenever a single job enters 'pending' status
      const jobStatus = payload.build_status;
      if (jobStatus === "pending") {
        isActionable = true;
        requiredWorkers = 1;
        activeStage = payload.build_stage || "job";
        pipelineId = payload.pipeline_id;
        refName = payload.ref;
      }
    }

    if (!isActionable) {
      return new Response(
        JSON.stringify({
          message: "Ignored event (no pending jobs requiring execution)",
          object_kind: objectKind,
          status: payload.object_attributes?.status || payload.build_status,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Resolve Target GitHub Repository
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter(Boolean);

    let targetRepo = null;
    if (pathSegments.length >= 2 && pathSegments[0] === "dispatch") {
      targetRepo = pathSegments[1];
    } else if (pathSegments.length === 1 && pathSegments[0] !== "dispatch") {
      targetRepo = pathSegments[0];
    }

    if (!targetRepo) {
      targetRepo = url.searchParams.get("repo");
    }

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

    // Dispatch JIT event to GitHub Actions
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
          pipeline_id: pipelineId,
          ref: refName,
          project_id: payload.project?.id || payload.project_id,
          project_name: payload.project?.name || payload.repository?.name,
          user: payload.user?.username || payload.user_username,
          stage: activeStage,
          workers: requiredWorkers,
          event_type: objectKind,
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
        message: "Successfully dispatched JIT runner event to GitHub Actions!",
        target_repo: `${githubOwner}/${targetRepo}`,
        pipeline_id: pipelineId,
        stage: activeStage,
        workers: requiredWorkers,
        event_type: objectKind,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  },
};
