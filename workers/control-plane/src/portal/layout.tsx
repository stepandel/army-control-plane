import type { FC, PropsWithChildren } from "hono/jsx";

interface LayoutProps {
  email: string;
  currentPath?: string;
}

const NavLink: FC<{ href: string; label: string; current?: string }> = ({
  href,
  label,
  current,
}) => (
  <a
    href={href}
    hx-get={href}
    hx-target="#content"
    hx-push-url="true"
    class={current === href ? "active" : ""}
  >
    {label}
  </a>
);

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  email,
  currentPath,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Army Control Plane</title>
      <link rel="stylesheet" href="/styles.css" />
      <script src="/htmx.min.js" />
    </head>
    <body>
      <div class="shell">
        <aside class="sidebar">
          <div class="sidebar-logo">Army CP</div>
          <nav class="sidebar-nav">
            <NavLink
              href="/portal/dashboard"
              label="Dashboard"
              current={currentPath}
            />
            <NavLink
              href="/portal/tenants"
              label="Tenants"
              current={currentPath}
            />
          </nav>
          <div class="sidebar-user">{email}</div>
        </aside>
        <main class="content" id="content">
          {children}
        </main>
      </div>
      <div id="toasts" class="toast-container" />
      <script>
        {`document.addEventListener('animationend', e => { if (e.target.classList.contains('toast')) e.target.remove(); });`}
      </script>
    </body>
  </html>
);
