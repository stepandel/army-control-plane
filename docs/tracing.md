# LLM Tracing Configuration

Vera uses LLM tracing to observe agent behavior — capturing LLM calls, tool invocations, token usage, and latencies. Two tracing backends are supported.

## Langfuse (default — production)

[Langfuse](https://langfuse.com) is the default tracing backend. It's open source, offers standard EU data residency, and is fully auditable.

Langfuse is automatically enabled when the required environment variables are set.

### Environment variables

| Variable | Type | Description |
|---|---|---|
| `LANGFUSE_SECRET_KEY` | Secret | Langfuse secret key (`sk-lf-...` format). Set as a Cloudflare Worker secret. |
| `LANGFUSE_PUBLIC_KEY` | Config | Langfuse public key (`pk-lf-...` format). Set in `wrangler.toml` `[vars]`. |
| `LANGFUSE_BASE_URL` | Config | Langfuse API endpoint. Default: `https://cloud.langfuse.com` (EU). Use `https://us.cloud.langfuse.com` for US region. |

### Setup

```sh
cd workers/control-plane

# Set the secret key (encrypted at rest)
wrangler secret put LANGFUSE_SECRET_KEY

# Set the public key and base URL in wrangler.toml [vars]:
#   LANGFUSE_PUBLIC_KEY = "pk-lf-..."
#   LANGFUSE_BASE_URL = "https://cloud.langfuse.com"
```

The control plane pushes these variables to tenant Fly machines:
- `LANGFUSE_SECRET_KEY` → Fly app secret (encrypted)
- `LANGFUSE_PUBLIC_KEY` → machine config.env
- `LANGFUSE_BASE_URL` → machine config.env

## LangSmith (opt-in — debug / non-prod)

[LangSmith](https://docs.smith.langchain.com) is available as an opt-in tracing backend for debugging and non-production environments. It provides a strong debugging UX (playground, prompt versioning, trace comparison).

**LangSmith is disabled by default.** It is only activated when explicitly opted in.

### Enabling LangSmith

Set `ENABLE_LANGSMITH` to `"true"` in the control plane environment:

```toml
# workers/control-plane/wrangler.toml
[vars]
ENABLE_LANGSMITH = "true"    # default: "false"
```

When enabled, the control plane will pass the following variables to tenant machines:

| Variable | Type | Description |
|---|---|---|
| `LANGSMITH_API_KEY` | Secret | LangSmith API key. Set as a Cloudflare Worker secret. |
| `LANGSMITH_TRACING` | Config | Set to `"true"` to enable tracing in the LangChain/LangSmith SDK. |
| `LANGSMITH_PROJECT` | Config | LangSmith project name for organizing traces. |

When `ENABLE_LANGSMITH` is `"false"` (default), none of these variables are passed to tenant machines, and LangSmith tracing is completely inactive.

### Dual tracing (both enabled)

When both Langfuse and LangSmith are configured, both tracers run simultaneously. Each agent session emits traces to both backends. This is useful for staging validation — comparing trace output side-by-side before cutting over.

## How tracing works

The tenant app subscribes to `AgentSessionEvent` events and maps them to trace observations:

| Agent event | Langfuse observation | LangSmith run |
|---|---|---|
| `agent_start` | Root span | Root chain run |
| `message_end` | Generation (with token usage) | LLM run |
| `tool_execution_start` | Tool span | Tool run |
| `tool_execution_end` | End tool span | End tool run |
| `agent_end` | End root span | End root run |

Traces are sent asynchronously and flushed on session end and process shutdown.
