# Deploy Collect to Render

Use the repository's Collect deployment branch. Import render.yaml as a Render Blueprint, or create a free Node web service with the same build/start commands. No database, wallet secret, RPC key or paid service is required. Review the free plan before creation; do not silently select a paid plan.

Render supplies PORT and RENDER_EXTERNAL_URL. The server binds 0.0.0.0 only when an explicit HTTPS public origin is configured; otherwise it stays loopback-only. It verifies the exact Host and Origin without trusting forwarded headers. The public root redirects to /basket. /healthz reports process health only, not RPC or wallet readiness. No transactions can be submitted by this app.

Manual build: npm ci --include=dev; npm run build. Start: node dist/web-server.js. Other hosts must set COLLECT_PUBLIC_ORIGIN to their HTTPS origin and PORT to the service port.

Keep config.json, .env files, wallet reports, generated plans, screenshots, local histories and reviews/ out of GitHub. Only source and explicitly reviewed deployment files belong in the publication commit. Automatic deployment is off so future local changes cannot publish implicitly.

This deployment is an evaluation preview: two concurrent backend checks, bounded request/response sizes and deadlines. Public RPCs and a free instance can throttle or sleep. Wallet connection, phone layout, actual atomic wallet execution and full fees need live verification. Do not label a health check as production readiness.

After deploy: verify HTTPS /basket and /healthz, wrong-origin rejection, a small unsigned simulation, and wallet connection on the intended phone/browser. The public URL is not proof of Base App directory publication.
