/* eslint-disable @typescript-eslint/no-empty-object-type */

/**
 * Extend Hono JSX intrinsic elements with HTMX attributes.
 * Without this, TypeScript rejects hx-* attributes on HTML elements.
 */
declare namespace JSX {
  type HtmxAttributes = {
    "hx-get"?: string;
    "hx-post"?: string;
    "hx-delete"?: string;
    "hx-put"?: string;
    "hx-patch"?: string;
    "hx-target"?: string;
    "hx-swap"?: string;
    "hx-trigger"?: string;
    "hx-push-url"?: string | boolean;
    "hx-confirm"?: string;
    "hx-indicator"?: string;
    "hx-vals"?: string;
    "hx-headers"?: string;
    "hx-select"?: string;
    "hx-boost"?: string | boolean;
  };

  // Augment IntrinsicElements to accept HTMX attributes on every HTML element
  interface HtmlAnchorTag extends HtmxAttributes {}
  interface HtmlButtonTag extends HtmxAttributes {}
  interface HtmlTag extends HtmxAttributes {}
  interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>;
  }
}
