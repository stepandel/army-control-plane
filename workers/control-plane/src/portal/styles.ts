export const css = /* css */ `
  :root {
    --bg: #0a0a0b;
    --surface: #141416;
    --surface-hover: #1c1c1f;
    --border: #27272a;
    --text: #fafafa;
    --text-muted: #a1a1aa;
    --accent: #3b82f6;
    --accent-hover: #2563eb;
    --success: #22c55e;
    --warning: #eab308;
    --danger: #ef4444;
    --danger-hover: #dc2626;
    --radius: 8px;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --mono: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ── Nav ────────────────────────────────────── */
  nav {
    display: flex;
    align-items: center;
    gap: 2rem;
    padding: 0 2rem;
    height: 56px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  nav .brand {
    font-weight: 700;
    font-size: 1rem;
    color: var(--text);
    letter-spacing: -0.025em;
  }
  nav .nav-links { display: flex; gap: 1.5rem; }
  nav .nav-links a {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-weight: 500;
    transition: color 0.15s;
  }
  nav .nav-links a:hover, nav .nav-links a.active {
    color: var(--text);
    text-decoration: none;
  }

  /* ── Layout ────────────────────────────────── */
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
  }
  .page-header h1 {
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.025em;
  }
  .page-header .subtitle {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin-top: 0.25rem;
  }

  /* ── Cards ─────────────────────────────────── */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }
  .card h2 {
    font-weight: 600;
    margin-bottom: 1rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.75rem;
  }

  .info-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 1rem;
  }
  .info-item label {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.25rem;
  }
  .info-item span {
    font-size: 0.9375rem;
    word-break: break-all;
  }
  .info-item .mono {
    font-family: var(--mono);
    font-size: 0.8125rem;
  }

  /* ── Table ─────────────────────────────────── */
  .table-wrap {
    overflow-x: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  thead th {
    text-align: left;
    padding: 0.75rem 1rem;
    font-weight: 600;
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  tbody td {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--surface-hover); }
  tbody tr { transition: background 0.1s; }

  .clickable-row { cursor: pointer; }
  .clickable-row:hover { background: var(--surface-hover); }

  /* ── Badge ─────────────────────────────────── */
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.625rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: capitalize;
  }
  .badge::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .badge-active { background: rgba(34,197,94,0.1); color: var(--success); }
  .badge-active::before { background: var(--success); }
  .badge-pending, .badge-provisioning, .badge-deploying {
    background: rgba(234,179,8,0.1); color: var(--warning);
  }
  .badge-pending::before, .badge-provisioning::before, .badge-deploying::before {
    background: var(--warning);
  }
  .badge-destroyed, .badge-stopped, .badge-failed, .badge-suspended {
    background: rgba(239,68,68,0.1); color: var(--danger);
  }
  .badge-destroyed::before, .badge-stopped::before, .badge-failed::before, .badge-suspended::before {
    background: var(--danger);
  }
  .badge-running { background: rgba(34,197,94,0.1); color: var(--success); }
  .badge-running::before { background: var(--success); }

  /* ── Buttons ───────────────────────────────── */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-radius: var(--radius);
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    transition: all 0.15s;
    font-family: var(--font);
    text-decoration: none;
  }
  .btn:hover { background: var(--surface-hover); text-decoration: none; }
  .btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn-danger {
    background: transparent;
    border-color: var(--danger);
    color: var(--danger);
  }
  .btn-danger:hover { background: var(--danger); color: white; }
  .btn-sm { padding: 0.375rem 0.75rem; font-size: 0.75rem; }

  .btn-group { display: flex; gap: 0.5rem; flex-wrap: wrap; }

  form.inline { display: inline; }

  /* ── Flash messages ────────────────────────── */
  .flash {
    padding: 0.75rem 1rem;
    border-radius: var(--radius);
    margin-bottom: 1.5rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .flash-success {
    background: rgba(34,197,94,0.1);
    border: 1px solid rgba(34,197,94,0.2);
    color: var(--success);
  }
  .flash-error {
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.2);
    color: var(--danger);
  }

  /* ── Confirm page ──────────────────────────── */
  .confirm-card {
    max-width: 480px;
    margin: 3rem auto;
    text-align: center;
  }
  .confirm-card h1 {
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
  }
  .confirm-card p {
    color: var(--text-muted);
    margin-bottom: 1.5rem;
    font-size: 0.875rem;
  }
  .confirm-card .tenant-name {
    font-family: var(--mono);
    color: var(--text);
    font-weight: 600;
  }

  /* ── Stats row ─────────────────────────────── */
  .stats {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .stat {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    flex: 1;
    min-width: 120px;
  }
  .stat .stat-value {
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.025em;
  }
  .stat .stat-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* ── Integration pills ─────────────────────── */
  .integrations {
    display: flex;
    gap: 0.5rem;
  }
  .integration-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.75rem;
    border-radius: var(--radius);
    font-size: 0.75rem;
    font-weight: 600;
    border: 1px solid var(--border);
  }
  .integration-pill.connected {
    border-color: rgba(34,197,94,0.3);
    color: var(--success);
  }
  .integration-pill.disconnected {
    color: var(--text-muted);
  }

  /* ── Breadcrumb ────────────────────────────── */
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    font-size: 0.875rem;
    color: var(--text-muted);
  }
  .breadcrumb a { color: var(--text-muted); }
  .breadcrumb a:hover { color: var(--text); }
  .breadcrumb .sep { color: var(--border); }

  /* ── Empty state ───────────────────────────── */
  .empty {
    text-align: center;
    padding: 3rem;
    color: var(--text-muted);
  }
  .empty p { margin-top: 0.5rem; font-size: 0.875rem; }

  /* ── Responsive ────────────────────────────── */
  @media (max-width: 768px) {
    main { padding: 1rem; }
    .stats { flex-direction: column; }
    .info-grid { grid-template-columns: 1fr; }
    nav { padding: 0 1rem; gap: 1rem; }
  }
`;
