# Provider Compatibility Matrix

BrowserCrew must distinguish an implemented preset or compatible code path from a certified provider deployment. The v0.2 provider gate in the PRD requires every advertised adapter to pass its declared capability suite.

| Connection | Implementation state | Automated evidence | v0.2 certification |
| --- | --- | --- | --- |
| Deterministic OpenAI-compatible test endpoint | Implemented | Installed-extension CI exercises connection and model requests through the OpenAI-compatible path | **Certified for controlled regression only** |
| OpenAI API preset | Implemented through OpenAI-compatible chat-completions request path | Static/runtime path covered; no live OpenAI credential is used in CI | **NOT CERTIFIED for v0.2 provider gate** |
| LM Studio preset | Implemented with editable loopback OpenAI-compatible endpoint | Connection path is structurally covered by deterministic local endpoint; no pinned live LM Studio model/version evidence | **NOT CERTIFIED for v0.2 provider gate** |
| Ollama preset | Implemented with editable loopback OpenAI-compatible endpoint | Connection path is structurally covered by deterministic local endpoint; no pinned live Ollama model/version evidence | **NOT CERTIFIED for v0.2 provider gate** |
| Anthropic API | Not implemented | None | **BLOCKED / NOT CERTIFIED** |

## What the current OpenAI-compatible path proves

The installed-extension suite proves BrowserCrew can persist non-secret provider settings, keep the supplied secret in session storage, request exact endpoint-origin permission, perform a connection request, issue bounded model requests for supported workflows, parse the expected response form, and surface failures through the extension runtime.

That does not prove external service uptime, account entitlements, model-specific tool behavior, pricing, vision, or every OpenAI-compatible implementation.

## v0.2 provider acceptance suite

Before a provider is advertised as v0.2 supported, record a pinned provider/server version and model where applicable and test: successful connection/authentication, normal generation, declared structured/tool behavior, malformed output, cancellation, throttling/rate-limit handling, timeout, typed authentication/error states, and usage reporting where the provider exposes it.

Cloud providers require HTTPS. Plain HTTP is allowed only for explicit loopback local endpoints (`localhost` or `127.0.0.1`). BrowserCrew does not scan the network for model servers and does not reuse browser cookies or consumer-subscription credentials.

## Public copy rule

Until the gate is complete, UI/README wording may say BrowserCrew has presets or an OpenAI-compatible connection path, but must not say OpenAI, LM Studio, Ollama, or Anthropic are fully certified v0.2 providers. A deterministic mock/stub result is never a substitute for live-provider evidence.
