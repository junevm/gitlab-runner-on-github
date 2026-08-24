/**
 * Parametric GitLab Webhook -> GitHub Actions Dispatch Bridge (Cloudflare Worker)
 *
 * Routes GitLab Pipeline webhooks to dedicated, isolated GitHub Action runner repos.
 * Supports both modern GitLab Standard Webhooks HMAC-SHA256 Signing Tokens
 * and legacy X-Gitlab-Token secret tokens with auto-detection.
 *
 * Routing Options:
 *   1. Path-based:   POST https://bridge.your-subdomain.workers.dev/dispatch/my-project-runner
 *   2. Query-based:  POST https://bridge.your-subdomain.workers.dev/dispatch?repo=my-project-runner
 *   3. Default:      Falls back to env.GH_DEFAULT_REPO if configured.
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

    // Check what credentials were provided by GitLab
    const headerToken = request.headers.get("X-Gitlab-Token");
    const signature = request.headers.get("webhook-signature");
    const messageId = request.headers.get("webhook-id");
    const timestamp = request.headers.get("webhook-timestamp");

    // Resolve configured signing token and secret token (with auto-detection)
    let configuredSigningToken = env.GITLAB_SIGNING_TOKEN;
    let configuredSecretToken = env.GITLAB_SECRET_TOKEN;

    // Auto-detect if user set whsec_ token in GITLAB_SECRET_TOKEN
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
    const pipelineStatus = payload.object_attributes?.status;

    // Only trigger when a pipeline is created, pending, or running
    const isPipelineEvent = objectKind === "pipeline" || eventType === "Pipeline Hook";
    const isActionableStatus = ["pending", "created", "running"].includes(pipelineStatus);

    if (!isPipelineEvent || !isActionableStatus) {
      return new Response(
        JSON.stringify({
          message: "Ignored event (not a pending/created pipeline event)",
          object_kind: objectKind,
          status: pipelineStatus,
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

    // Query parameter fallback: ?repo=...
    if (!targetRepo) {
      targetRepo = url.searchParams.get("repo");
    }

    // Default repo fallback
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
