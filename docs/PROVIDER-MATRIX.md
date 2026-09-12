# Provider Compatibility Matrix

BrowserCrew must distinguish an implemented preset or compatible code path from a certified provider deployment. The v0.2 provider gate in the PRD requires every advertised adapter to pass its declared capability suite.

| Connection | Implementation state | Automated evidence | v0.2 certification |
| --- | --- | --- | --- |
| Deterministic OpenAI-compatible test endpoint | Implemented | Installed-extension CI exercises connection and model requests through the OpenAI-compatible path | **Certified for controlled regression only** |
| OpenAI API preset | Implemented through OpenAI-compatible chat-completions request path | Static/runtime path covered; no live OpenAI credential is used in CI | **NOT CERTIFIED for v0.2 provider gate** |
| LM Studio preset | Implemented with editable loopback OpenAI-compatible endpoint | Connection path is structurally covered by deterministic local endpoint; no pinned live LM Studio model/version evidence | **NOT CERTIFIED for v0.2 provider gate** |
| Ollama preset | Implemented with editable loopback OpenAI-compatible endpoint | Connection path is structurally covered by deterministic local endpoint; no pinned live Ollama model/version evidence | **NOT CERTIFIED for v0.2 provider gate** |
| Anthropic API | Implemented through the native Messages API adapter | Deterministic adapter contracts plus installed-Chromium protocol coverage exercise Messages auth/header shape, normal + streaming generation, tools, cancellation, usage, typed failures, timeout, session-only credentials, raw-error redaction, and hidden-thinking non-exposure | **NOT CERTIFIED for live v0.2 provider gate** |

## What the current controlled provider paths prove

The installed-extension suite proves BrowserCrew can persist non-secret provider settings, keep supplied secrets in session storage, request exact endpoint-origin permission, perform connection requests, issue bounded model requests for supported workflows, parse normalized responses, and surface safe failures through the extension runtime.

For Anthropic specifically, BrowserCrew keeps its existing normalized internal model/tool contract while the shared provider adapter translates only Anthropic-bound traffic to the native `/v1/messages` protocol. It sends the Anthropic API key only in the provider-specific request header, never exposes private thinking blocks to BrowserCrew UI/history, and keeps any thinking blocks required for a tool-result continuation only in short-lived in-memory adapter state.

Controlled protocol evidence does not prove external service uptime, account entitlements, provider-side model behavior in production, pricing, vision, or every advertised deployment. It must not be presented as live-provider certification.

## v0.2 provider acceptance suite

Before a provider is advertised as v0.2 supported, record a pinned provider/server version and model where applicable and test: successful connection/authentication, normal generation, declared structured/tool behavior, malformed output, cancellation, throttling/rate-limit handling, timeout, typed authentication/error states, and usage reporting where the provider exposes it.

Cloud providers require HTTPS. Plain HTTP is allowed only for explicit loopback local endpoints (`localhost` or `127.0.0.1`). BrowserCrew does not scan the network for model servers and does not reuse browser cookies or consumer-subscription credentials.

## Public copy rule

Until the live-provider gate is complete, UI/README wording may say BrowserCrew has OpenAI, Anthropic, LM Studio, and Ollama connection presets or compatible adapter paths, but must not say those external providers are fully certified for v0.2. A deterministic mock/stub result is never a substitute for live-provider evidence.
