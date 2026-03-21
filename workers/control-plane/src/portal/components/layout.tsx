import type { FC, PropsWithChildren } from "hono/jsx";

interface LayoutProps {
  title?: string;
  email?: string;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, email, children }) => {
  const pageTitle = title ? `${title} — Army Portal` : "Army Portal";

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{pageTitle}</title>
        <style>{styles}</style>
      </head>
      <body>
        <nav class="navbar">
          <div class="navbar-inner">
            <a href="/portal" class="navbar-brand">
              <span class="brand-icon">⚔️</span> Army Portal
            </a>
            <div class="navbar-links">
              <a href="/portal">Dashboard</a>
              <a href="/portal/setup">Setup</a>
              {email && <span class="navbar-email">{email}</span>}
            </div>
          </div>
        </nav>
        <main class="container">{children}</main>
        <script>{clientScript}</script>
      </body>
    </html>
  );
};

const clientScript = `
  async function portalAction(url, method, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Working...';
    try {
      const resp = await fetch(url, { method });
      const data = await resp.json();
      if (!resp.ok) {
        alert('Error: ' + (data.error || resp.statusText));
        btn.disabled = false;
        btn.textContent = btn.dataset.label;
        return;
      }
      window.location.reload();
    } catch (err) {
      alert('Request failed: ' + err.message);
      btn.disabled = false;
      btn.textContent = btn.dataset.label;
    }
  }
`;

const styles = `
  :root {
    --bg: #0a0a0b;
    --bg-card: #141416;
    --bg-card-hover: #1a1a1e;
    --border: #27272a;
    --border-hover: #3f3f46;
    --text: #fafafa;
    --text-muted: #a1a1aa;
    --text-dim: #71717a;
    --accent: #3b82f6;
    --accent-hover: #2563eb;
    --green: #22c55e;
    --green-bg: rgba(34, 197, 94, 0.1);
    --yellow: #eab308;
    --yellow-bg: rgba(234, 179, 8, 0.1);
    --red: #ef4444;
    --red-bg: rgba(239, 68, 68, 0.1);
    --blue: #3b82f6;
    --blue-bg: rgba(59, 130, 246, 0.1);
    --purple: #a855f7;
    --purple-bg: rgba(168, 85, 247, 0.1);
    --radius: 8px;
    --radius-lg: 12px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }

  .navbar {
    background: var(--bg-card);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .navbar-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 24px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .navbar-brand {
    font-size: 18px;
    font-weight: 700;
    color: var(--text);
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .brand-icon { font-size: 22px; }

  .navbar-links {
    display: flex;
    align-items: center;
    gap: 24px;
  }

  .navbar-links a {
    color: var(--text-muted);
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    transition: color 0.15s;
  }

  .navbar-links a:hover { color: var(--text); }
  .navbar-email { color: var(--text-dim); font-size: 13px; }

  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 32px 24px;
  }

  h1 {
    font-size: 28px;
    font-weight: 700;
    margin-bottom: 8px;
  }

  h2 {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 16px;
  }

  h3 {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 12px;
  }

  .page-header {
    margin-bottom: 32px;
  }

  .page-header p {
    color: var(--text-muted);
    font-size: 15px;
  }

  .stats-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 32px;
  }

  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
  }

  .stat-label {
    font-size: 13px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }

  .stat-value {
    font-size: 32px;
    font-weight: 700;
  }

  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 24px;
    margin-bottom: 16px;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .tenant-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 8px;
    text-decoration: none;
    color: var(--text);
    transition: background 0.15s, border-color 0.15s;
  }

  .tenant-row:hover {
    background: var(--bg-card-hover);
    border-color: var(--border-hover);
  }

  .tenant-info {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .tenant-name {
    font-weight: 600;
    font-size: 15px;
  }

  .tenant-id {
    font-size: 13px;
    color: var(--text-dim);
    font-family: 'SF Mono', Monaco, monospace;
  }

  .tenant-meta {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .badge-active { background: var(--green-bg); color: var(--green); }
  .badge-pending { background: var(--yellow-bg); color: var(--yellow); }
  .badge-provisioning { background: var(--blue-bg); color: var(--blue); }
  .badge-destroyed { background: var(--red-bg); color: var(--red); }
  .badge-suspended { background: var(--purple-bg); color: var(--purple); }

  .badge-slack { background: #4a154b22; color: #e01e5a; }
  .badge-linear { background: #5e6ad222; color: #5e6ad2; }
  .badge-github { background: #23863622; color: #3fb950; }

  .platform-badges {
    display: flex;
    gap: 6px;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .detail-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .detail-label {
    font-size: 12px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .detail-value {
    font-size: 14px;
    color: var(--text);
    font-family: 'SF Mono', Monaco, monospace;
    word-break: break-all;
  }

  .integration-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .integration-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }

  .integration-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .integration-platform {
    font-weight: 600;
    font-size: 15px;
    text-transform: capitalize;
  }

  .integration-status {
    font-size: 13px;
    color: var(--text-muted);
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    border: 1px solid var(--border);
    background: var(--bg-card);
    color: var(--text);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    text-decoration: none;
  }

  .btn:hover {
    background: var(--bg-card-hover);
    border-color: var(--border-hover);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }

  .btn-primary:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .btn-danger {
    color: var(--red);
    border-color: rgba(239, 68, 68, 0.3);
  }

  .btn-danger:hover {
    background: var(--red-bg);
    border-color: var(--red);
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    text-align: left;
    font-size: 12px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }

  td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }

  tr:last-child td { border-bottom: none; }

  .empty-state {
    text-align: center;
    padding: 64px 24px;
    color: var(--text-muted);
  }

  .empty-state h2 {
    margin-bottom: 8px;
    color: var(--text);
  }

  .empty-state p { margin-bottom: 24px; }

  .setup-steps {
    counter-reset: step;
  }

  .setup-step {
    display: flex;
    gap: 16px;
    margin-bottom: 24px;
    padding: 20px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .step-number {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    background: var(--accent);
    color: white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
  }

  .step-content h3 { margin-bottom: 4px; }
  .step-content p { color: var(--text-muted); font-size: 14px; }

  .step-content code {
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
    font-family: 'SF Mono', Monaco, monospace;
  }

  .back-link {
    color: var(--text-muted);
    text-decoration: none;
    font-size: 14px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 16px;
  }

  .back-link:hover { color: var(--text); }

  .section { margin-bottom: 32px; }

  .timestamp {
    color: var(--text-dim);
    font-size: 13px;
  }
`;
