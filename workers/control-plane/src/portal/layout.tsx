import type { FC, PropsWithChildren } from "hono/jsx";
import { css } from "./styles";

export const Layout: FC<PropsWithChildren<{ title?: string }>> = (props) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>
          {props.title ? `${props.title} — Army Portal` : "Army Portal"}
        </title>
        <style>{css}</style>
      </head>
      <body>
        <nav>
          <a href="/portal" class="brand">
            ⚔ Army Control Plane
          </a>
          <div class="nav-links">
            <a href="/portal">Tenants</a>
          </div>
        </nav>
        <main>{props.children}</main>
      </body>
    </html>
  );
};
