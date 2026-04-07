import type { APIRoute } from "astro";

export const prerender = false;

/**
 * Catch-all proxy for /api/account/* → control-plane via service binding.
 *
 * The session cookie uses the `__Host-` prefix, which locks it to the website
 * host. A direct browser fetch from the website to the control-plane worker on
 * a different host cannot carry that cookie, so we proxy server-side and
 * forward the cookie as a plain header. Same pattern as the GET /billing call
 * in account/billing.astro.
 */
const handler: APIRoute = async ({ request, locals, params }) => {
  const controlPlane: { fetch: typeof fetch } = locals.runtime.env.CONTROL_PLANE;

  const subPath = params.path ?? "";
  const targetUrl = `https://api/api/account/${subPath}`;

  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  const upstream = await controlPlane.fetch(targetUrl, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
