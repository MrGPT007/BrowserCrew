# Provider compatibility matrix

| Connection | Implemented transport | Verification status |
| --- | --- | --- |
| OpenAI-compatible cloud | HTTPS /chat/completions, one native tool call, max_tokens, no streaming | Protocol implemented; real service/model test outstanding |
| Local compatible server | Explicit localhost/127.0.0.1/[::1] /chat/completions | Scripted HTTP fixture coverage only |
| LM Studio | Address preset and compatible transport | Requires real local server/model trial |
| Ollama | Address example and compatible transport | Requires real local server/model trial |
| Anthropic native API | None | v0.2 work |
| ChatGPT/Claude subscription | None | Unsupported until an official third-party route is validated |

Connection testing sends a harmless tool-use request with no actual page content. Passing confirms one tool call, not every model capability. Vision, streaming and automatic model discovery are not implemented. The model ID is supplied by the user.

Requests stop after 20 seconds. There is no fallback endpoint or automatic write retry. HTTP errors are mapped to safe messages without echoing server content. Credential use is bound to the configured base URL.

Step limit: 3–50, default 50. Active work time limit: 10 minutes. Reported token ceiling: 30,000 before another request; one in-flight request can exceed it. If usage is omitted, the UI reports it as unknown and step/time limits still apply. This is not a guaranteed money cap.
